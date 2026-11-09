import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from 'playwright';

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
}

test('web fetch confirmation displays the complete URL safely and submits explicit decisions', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-fetch-ui-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-fetch-ui-state-'));
  let server; let browser;
  try {
    await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
    const serverPort = await port(); let assetPort = await port(); while (assetPort === serverPort) assetPort = await port();
    server = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PI_OFFLINE: '1', OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(serverPort), OK_WORKBENCH_ASSET_PORT: String(assetPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 8000); server.stdout.once('data', () => { clearTimeout(timer); resolve(); }); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
    browser = await chromium.launch(); const page = await browser.newPage();
    const decisions = []; const externalRequests = [];
    page.on('request', request => { if (new URL(request.url()).hostname.endsWith('example.com')) externalRequests.push(request.url()); });
    await page.route('**/web-fetch-confirmations/*', async route => { decisions.push({ body: route.request().postDataJSON(), browser: route.request().headers()['x-ok-workbench-browser'] }); await route.fulfill({ status: 204 }); });
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/`, { waitUntil: 'domcontentloaded' });
    const csrf = await page.locator('meta[name="ok-workbench-csrf"]').getAttribute('content');
    const endpoint = `http://127.0.0.1:${serverPort}/api/chat/threads/thread/turns/turn/web-fetch-confirmations/unknown`;
    const body = { decision: 'allow' }; const headers = { 'x-ok-workbench-csrf': csrf, 'x-ok-workbench-browser': 'b'.repeat(64) };
    assert.equal((await page.request.post(endpoint, { data: body })).status(), 400);
    assert.equal((await page.request.post(endpoint, { headers: { ...headers, origin: 'https://attacker.invalid' }, data: body })).status(), 400);
    assert.equal((await page.request.post(endpoint, { headers, data: { ...body, url: 'https://attacker.invalid/' } })).status(), 400);
    assert.equal((await page.request.post(endpoint, { headers, data: body })).status(), 404);
    await page.waitForFunction(() => typeof window.showWebFetchPrompt === 'function');
    const target = 'https://xn--bcher-kva.example.com/a?secret=%3Cimg%20src%3Dx%3E';
    const turn = { threadId: 'thread', id: 'turn', browserId: 'b'.repeat(64) };
    await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); const button = document.createElement('button'); button.id = 'focus-origin'; button.textContent = 'Focus origin'; document.body.append(button); button.focus(); });
    await page.evaluate(({ turn, target }) => window.showWebFetchPrompt(turn, { request_id: 'request1', hop: 0, url: target }), { turn, target });
    const panel = page.getByRole('region', { name: 'Web fetch confirmation' });
    assert.match(await page.locator('#web-fetch-announcements').innerText(), /waiting for your decision/i);
    assert.equal(await panel.getByLabel('Exact URL to fetch').inputValue(), target);
    assert.match(await panel.innerText(), /xn--bcher-kva\.example\.com/);
    assert.equal(await panel.locator('img, a').count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'Deny' }).evaluate(el => document.activeElement === el), true);
    assert.equal(decisions.length, 0);
    await page.keyboard.press('Enter'); await panel.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#focus-origin').evaluate(element => document.activeElement === element), true);
    assert.deepEqual(decisions[0], { body: { decision: 'deny' }, browser: turn.browserId });
    await page.evaluate(({ turn, target }) => window.showWebFetchPrompt(turn, { request_id: 'request2', hop: 1, previous_origin: 'https://previous.example.com', url: target }), { turn, target });
    assert.match(await panel.innerText(), /Redirect from https:\/\/previous\.example\.com/);
    await panel.getByRole('button', { name: 'Allow this fetch' }).click(); await panel.waitFor({ state: 'detached' });
    assert.deepEqual(decisions[1].body, { decision: 'allow' });
    await page.evaluate(({ turn }) => window.showWebFetchPrompt(turn, { request_id: 'request3', hop: 0, url: 'https://example.com/\u202edanger' }), { turn });
    assert.equal(await panel.getByLabel('Exact URL to fetch').inputValue(), 'https://example.com/\\u202edanger');
    await page.evaluate(() => window.removeWebFetchPrompt('request3'));
    assert.deepEqual(externalRequests, [], 'confirmation must not fetch previews or favicons');
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
});
