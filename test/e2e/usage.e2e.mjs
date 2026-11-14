import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch {}

test('usage navigation retains a draft and filters the snapshot', { skip: !chromium }, async t => {
  const socketAllowed = await new Promise(resolve => { const probe = net.createServer(); probe.once('error', () => resolve(false)); probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true))); });
  if (!socketAllowed) { t.skip('Local server sockets are blocked by the sandbox'); return; }
  const dir = await mkdtemp(path.join(tmpdir(), 'usage-ui-'));
  const workspace = path.join(dir, 'index.md'); await writeFile(workspace, '# Workspace\n');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, OK_WORKSPACE_ROOT: dir, OK_WORKBENCH_STATE_DIR: path.join(dir, 'state'), PORT: String(port), OK_WORKBENCH_ASSET_PORT: String(port + 1) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    let serverError = ''; server.stderr.on('data', data => { serverError += String(data); });
    const started = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Server did not start')), 10000); server.stdout.once('data', data => { const output = String(data); clearTimeout(timer); if (output.includes('listen EPERM')) resolve(false); else if (output.includes('could not open')) reject(new Error(output)); else resolve(true); }); server.once('exit', code => { clearTimeout(timer); if (code && serverError.includes('listen EPERM')) resolve(false); else if (code) reject(new Error(`Server exited ${code}: ${serverError}`)); }); });
    if (!started) { t.skip('Local server sockets are blocked by the sandbox'); return; }
    try { browser = await chromium.launch(); } catch { t.skip('Chromium is not installed'); return; }
    const real = await browser.newPage(); const modelCalls = [];
    real.on('request', request => { if (/\/api\/(?:chat\/(?:turn|stream)|workspace-review\/runs)/.test(request.url())) modelCalls.push(request.url()); });
    await real.route('**/api/chat/catalog-refresh', route => route.fulfill({json:{}}));
    await real.goto(`http://127.0.0.1:${port}/usage/`); await real.getByText('No model requests in this period.').waitFor();
    await real.reload(); await real.getByText('No model requests in this period.').waitFor(); assert.deepEqual(modelCalls, []); await real.close();
    const initialError = await browser.newPage(); let initialFails = true;
    await initialError.route('**/api/chat/catalog-refresh', route => route.fulfill({json:{}}));
    await initialError.route('**/api/usage/report?*', route => initialFails ? route.fulfill({status:503,json:{error:'Ledger unavailable'}}) : route.continue());
    await initialError.goto(`http://127.0.0.1:${port}/usage/`); await initialError.getByText('Ledger unavailable').waitFor(); initialFails = false; await initialError.getByRole('button',{name:'Retry'}).click(); await initialError.getByText('No model requests in this period.').waitFor(); await initialError.close();
    const page = await browser.newPage();
    const metrics = { requests:1,operations:1,complete:1,partial:0,unavailable:0,inFlight:0,inputUncached:7,cacheRead:1,cacheWrite:0,output:2,totalTokens:10,unclassified:0 };
    let failNext = false, state = 'normal', requestsSeen = [], exportQuery = '';
    await page.route('**/api/usage/export?*', route => { exportQuery = new URL(route.request().url()).search; return route.fulfill({status:200,contentType:'text/csv',body:'label,total\r\nAlpha,10\r\n'}); });
    await page.route('**/api/usage/report?*', route => {
      if (failNext) { failNext = false; return route.fulfill({status:503,json:{error:'Ledger unavailable'}}); }
      const query = new URL(route.request().url()).searchParams; requestsSeen.push(query.toString()); const kind = query.get('breakdown') || 'projects';
      const current = state === 'empty' || state === 'nomatch' ? {...metrics,requests:0,operations:0,totalTokens:0,inputUncached:0,cacheRead:0,output:0,complete:0} : state === 'unknown' ? {...metrics,totalTokens:null,inputUncached:null,cacheRead:null,cacheWrite:null,output:null,complete:0,unavailable:1,inFlight:1} : metrics;
      const rows = state === 'empty' || state === 'nomatch' ? [] : kind === 'models' ? [{id:'fake-model',label:'fake / model',provider:'fake',model:'model',metrics}] : kind === 'activities' ? [{id:'chat',label:'chat',metrics,subtasks:[{id:'compaction',label:'compaction',metrics}],retries:metrics}] : kind === 'operations' ? [{id:'op-1',label:'op-1',startedAt:'2026-01-01T01:00:00Z',trigger:'user',projectId:'alpha',status:'completed',metrics}] : [{id:'alpha',label:'Alpha',metrics}];
      return route.fulfill({ json: { snapshot:'test',asOf:'2026-01-01T12:00:00Z',range:{from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'},timezone:'UTC',trackingStartedAt:'2026-01-01T00:00:00Z',health:{gaps:[]},totals:current,buckets:[{start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z',label:'January 1',coverage:'tracked',partial:false,metrics:current,activities:[{id:'chat',label:'chat',metrics:current}]}],options:{projects:[{id:'alpha',label:'Alpha'}],activities:['chat'],models:[{provider:'fake',model:'model'}]},breakdown:{type:kind,rows},nextCursor:null } });
    });
    await page.route('**/api/usage/operations/op-1?*', route => { const next = new URL(route.request().url()).searchParams.has('cursor'); return route.fulfill({json:{requests:[{startedAt:'2026-01-01T01:00:00Z',provider:'fake',model:next?'second':'first',status:'completed',totalTokens:10,usageCoverage:'complete',attempt:1}],nextCursor:next?null:'next-page'}}); });
    await page.route('**/api/chat/catalog-refresh', route => route.fulfill({ json:{} }));
    await page.goto(`http://127.0.0.1:${port}/workspace/`); await page.evaluate(() => { document.querySelector('#chat-input').value = 'Draft text'; document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); });
    await page.getByRole('link', { name:'Usage reporting' }).click();
    await page.getByRole('heading', { name:'Model usage' }).waitFor();
    assert.equal(await page.locator('#project-name').textContent(), 'Usage');
    for (const [preset,bucket] of [['last_24_hours','hour'],['last_30_days','day'],['last_year','week'],['last_12_months','month']]) {
      await page.locator('[data-usage-field="preset"]').selectOption(preset); await page.waitForURL(new RegExp(`preset=${preset}`)); await page.waitForFunction(expected => document.querySelector('[data-usage-field="bucket"]').value === expected, bucket);
    }
    await page.locator('[data-usage-field="preset"]').selectOption('custom'); await page.locator('[data-usage-date="from"]').fill('2026-01-01T00:00:00Z'); await page.locator('[data-usage-date="to"]').fill('2026-01-02T00:00:00Z'); await page.getByRole('button',{name:'Apply range'}).click(); await page.waitForURL(/from=/);
    await page.locator('[data-usage-field="preset"]').selectOption('last_30_days'); await page.waitForURL(/preset=last_30_days/);
    await page.getByLabel('Usage breakdown').getByRole('button',{name:'Models'}).click(); await page.getByRole('button',{name:'fake / model'}).click(); await page.waitForURL(/provider=fake/);
    await page.locator('[data-usage-field="project"]').selectOption('alpha'); await Promise.all([page.waitForResponse(response => response.url().includes('activity=chat') && response.url().includes('/api/usage/report')), page.locator('[data-usage-field="activity"]').selectOption('chat')]);
    await page.waitForURL(/activity=chat/); assert.ok(requestsSeen.some(query => query.includes('provider=fake') && query.includes('model=model') && query.includes('project=alpha') && query.includes('activity=chat')));
    await page.reload(); await page.getByRole('heading',{name:'Model usage'}).waitFor(); await page.evaluate(() => { document.querySelector('#chat-input').value = 'Draft text'; }); assert.equal(await page.locator('[data-usage-field="project"]').inputValue(),'alpha'); assert.equal(await page.locator('[data-usage-field="activity"]').inputValue(),'chat');
    await page.getByRole('button',{name:'Export CSV'}).focus(); const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]); assert.equal(download.suggestedFilename(),'usage.csv'); assert.match(exportQuery,/snapshot=test/); assert.match(exportQuery,/provider=fake/);
    await page.getByRole('button',{name:'Clear filters'}).click(); await page.waitForFunction(() => !location.search.includes('project='));
    await page.getByLabel('Usage breakdown').getByRole('button',{name:'Projects'}).click();
    state='empty'; await page.getByRole('button',{name:'Refresh',exact:true}).click(); await page.getByText('No model requests in this period.').waitFor();
    state='nomatch'; await page.locator('[data-usage-field="project"]').selectOption('alpha'); await page.getByText('No usage matches these filters.').waitFor(); await page.getByRole('button',{name:'Clear filters'}).click();
    state='unknown'; await page.getByRole('button',{name:'Refresh',exact:true}).click(); await page.getByText('Unavailable',{exact:true}).first().waitFor(); assert.match(await page.locator('.usage-total').innerText(),/1 in flight/);
    state='normal'; await page.getByRole('button',{name:'Refresh',exact:true}).click(); await page.waitForFunction(() => document.querySelector('.usage-total strong').textContent === '10');

    assert.equal(await page.locator('.usage-total strong').textContent(), '10');
    assert.equal(await page.locator('#chat-pane').isVisible(), false);
    await page.getByRole('button', {name:/January 1: 10 tokens/}).focus(); await page.keyboard.press('Enter'); await page.getByRole('button', {name:/Selected period/}).waitFor();
    await page.getByRole('button', {name:/Selected period/}).click();
    await page.locator('[data-usage-metric]').selectOption('requests'); assert.match(await page.locator('.usage-legend').innerText(), /Requests by activity/);
    await page.locator('[data-usage-metric]').selectOption('tokens');
    await page.getByText('Show data table').focus(); await page.keyboard.press('Enter');
    assert.match(await page.locator('.usage-report').innerHTML(), /Cache read/);
    await page.getByRole('button', { name:'Refresh', exact:true }).focus(); await page.keyboard.press('Enter');
    await page.waitForTimeout(300); assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-usage-refresh')), true);
    failNext = true; await page.getByRole('button', {name:'Refresh', exact:true}).click(); await page.getByText(/Out of date/).waitFor(); assert.equal(await page.locator('.usage-total strong').textContent(), '10'); await page.getByRole('button', {name:'Retry', exact:true}).click();
    await page.getByRole('button', {name:'Activities', exact:true}).click();
    await page.getByText('Show subtasks').click(); assert.match(await page.locator('.usage-subtasks').innerText(), /Compaction/); assert.match(await page.locator('.usage-subtasks').innerText(), /Retries/);
    await page.getByLabel('Usage breakdown').getByRole('button', {name:'Operations', exact:true}).click(); await page.getByRole('button', {name:'op-1'}).focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', {name:'More requests'}).click(); await page.getByText(/fake \/ second/).waitFor();
    await page.getByLabel('Usage breakdown').getByRole('button', {name:'Projects', exact:true}).click();
    for (const [scheme,viewport,name] of [['light',{width:1280,height:900},'desktop-light'],['dark',{width:1280,height:900},'desktop-dark'],['light',{width:360,height:800},'mobile-light'],['dark',{width:360,height:800},'mobile-dark']]) {
      await page.emulateMedia({colorScheme:scheme}); await page.setViewportSize(viewport); await page.evaluate(() => { document.querySelector('#app-layout').classList.remove('chat-collapsed'); document.querySelector('#document').scrollTop = 0; window.scrollTo(0, 0); });
      if (viewport.width > 900) { const dimensions = await page.evaluate(() => ({ document:document.querySelector('#document').getBoundingClientRect().width, workspace:document.querySelector('.workspace').getBoundingClientRect().width })); assert.ok(Math.abs(dimensions.document - Math.min(1200,dimensions.workspace)) < 2, `${name}: report width ${dimensions.document}, available ${dimensions.workspace}`); }
      await page.screenshot({path:`/tmp/usage-${name}.png`,fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`${name} page overflow`);
      const ratio = await page.evaluate(() => { const c = s => s.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(v => { v/=255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4; }); const lum = a => .2126*a[0]+.7152*a[1]+.0722*a[2]; const foreground=lum(c(getComputedStyle(document.querySelector('.usage-note')).color)); const background=lum(c(getComputedStyle(document.querySelector('#document')).backgroundColor)); return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05); }); assert.ok(ratio >= 4.5,`${name} muted text contrast ${ratio}`); console.log(`${name}: muted text contrast ${ratio.toFixed(2)}:1`); const links = await page.evaluate(() => { const c = s => s.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(v => { v/=255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4; }); const l = a => .2126*a[0]+.7152*a[1]+.0722*a[2]; const fg=l(c(getComputedStyle(document.querySelector('.usage-report a')).color)), bg=l(c(getComputedStyle(document.querySelector('#document')).backgroundColor)); return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05); }); assert.ok(links >= 4.5,`${name} link contrast ${links}`); console.log(`${name}: link contrast ${links.toFixed(2)}:1`);
    }
    await page.setViewportSize({width:360,height:800}); assert.equal(await page.locator('.usage-custom').isVisible(), false); await page.screenshot({path:'/tmp/usage-mobile-light.png',fullPage:true});
    await page.emulateMedia({colorScheme:'dark'}); await page.screenshot({path:'/tmp/usage-mobile-dark.png',fullPage:true});
    await page.setViewportSize({width:1280,height:900}); await page.getByRole('button', { name:'Alpha' }).click();
    await page.waitForURL('**/usage/?*project=alpha*');
    while (new URL(page.url()).pathname.startsWith('/usage')) await page.goBack();
    await page.waitForFunction(() => document.querySelector('#project-name').textContent !== 'Usage'); assert.equal(await page.locator('#chat-input').inputValue(), 'Draft text'); assert.equal(await page.locator('#app-layout').evaluate(element => element.classList.contains('usage-active')), false);
  } finally { await browser?.close(); server.kill(); await rm(dir, { recursive:true, force:true }); }
});
