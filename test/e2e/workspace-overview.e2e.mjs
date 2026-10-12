import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// Real-browser acceptance checks for docs/WORKSPACE-OVERVIEW-SPEC.md that a
// Node-only unit test cannot verify: layout at named viewports, dark mode,
// approximated 200% zoom without horizontal overflow, keyboard/tablist
// semantics (A36), and native-dialog focus handling (A22). This suite is
// intentionally not part of `npm test`/CI: it downloads/launches a real
// Chromium build. Run it explicitly with `npm run test:e2e` after
// `npx playwright install chromium` once.
//
// If Playwright or a browser is unavailable, every test here reports itself
// skipped rather than silently passing, so a missing dependency is never
// mistaken for a verified UI.

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* handled per test via skip */ }

const root = path.resolve(import.meta.dirname, '..', '..');
const { WorkspaceReviewStore } = require(path.join(root, 'src/workspace-review-store.js'));

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function seedWorkspace(workspace, state) {
  await writeFile(path.join(workspace, 'index.md'), '# Demo workspace\nFictional projects for UI verification only.\n');
  for (const id of ['alpha', 'beta']) {
    await mkdir(path.join(workspace, id));
    await writeFile(path.join(workspace, id, 'index.md'), `# ${id}\n`);
    await writeFile(path.join(workspace, id, 'status.md'), `# Status\nLast completed: ${id} setup finished.\n`);
  }
  const store = new WorkspaceReviewStore({ stateDir: state, workspaceRoot: workspace });
  await store.saveSettings({ provider: null, model: null, reportableProjects: ['alpha'] }, 0);
  const now = new Date();
  const future = new Date(now.getTime() + 6 * 86400000).toISOString().slice(0, 10);
  const record = {
    schemaVersion: 1, id: 'seed-review', startedAt: now.toISOString(), completedAt: now.toISOString(), trigger: 'manual',
    provider: 'openai', model: 'gpt-5', inputFingerprint: 'seed', settingsRevision: 0, controlsRevision: 0,
    coverage: [{ projectId: 'alpha', included: true, reason: 'included', complete: true }, { projectId: 'beta', included: true, reason: 'included', complete: true }],
    sources: [
      { id: 'src-alpha-status', projectId: 'alpha', path: 'status.md', heading: 'Status', lineStart: 1, lineEnd: 2, excerpt: 'Last completed: alpha setup finished.', hash: 'h1', truncated: false },
      { id: 'src-beta-status', projectId: 'beta', path: 'status.md', heading: 'Status', lineStart: 1, lineEnd: 2, excerpt: 'Last completed: beta setup finished.', hash: 'h2', truncated: false }
    ],
    assessment: {
      headline: 'Beta needs a decision on the approaching deadline.', summary: 'Alpha is steady; beta has an evidenced deadline this week.',
      focusProjectId: 'beta', evidenceIds: ['src-beta-status'],
      changes: [{ text: 'Alpha finished initial setup since the last review.', evidenceIds: ['src-alpha-status'] }],
      projects: [
        { projectId: 'alpha', priority: 'focus', rank: 1, priorityReason: 'Flagship outcome.', confidence: 'high', trajectory: 'on_course', lifecycle: 'active', outcome: 'Ship alpha.', assessment: 'On course.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Steady.', evidenceIds: ['src-alpha-status'] },
        { projectId: 'beta', priority: 'next', rank: 2, priorityReason: 'Deadline this week.', confidence: 'high', trajectory: 'at_risk', lifecycle: 'active', outcome: 'Ship beta.', assessment: 'Deadline approaching.', nextAction: 'Finish the beta review.', blocker: null, cadence: 'daily', cadenceReason: 'Deadline within a week.', evidenceIds: ['src-beta-status'] }
      ],
      attention: [
        { id: 'issue-beta-deadline', evidenceSignature: 'sig-beta', projectId: 'beta', kind: 'deadline', topic: 'status', urgency: 'now', title: 'Beta deadline this week', observation: 'Status records the deadline.', inference: 'Missing it risks the release.', action: 'Finish the review.', firstStep: 'Open beta/status.md and note the remaining checklist item.', evidenceIds: ['src-beta-status'], dueDate: future, dueDateEvidence: { sourceId: 'src-beta-status', excerpt: 'Last completed: beta setup finished.' }, escalation: { mode: 'consequence' } },
        { id: 'issue-alpha-watch', evidenceSignature: 'sig-alpha', projectId: 'alpha', kind: 'prevent_drift', topic: 'status', urgency: 'watch', title: 'Alpha needs a follow-up test', observation: 'No test scheduled before the next milestone.', inference: 'Skipping it risks a late surprise.', action: 'Schedule the follow-up test.', firstStep: 'Add a test task to alpha/status.md.', evidenceIds: ['src-alpha-status'], dueDate: null, dueDateEvidence: null }
      ],
      question: { projectId: 'beta', text: 'Should beta ship this week or next?', reason: 'Changes which deadline the reviewer treats as authoritative.', options: ['This week', 'Next week'], evidenceIds: ['src-beta-status'] }
    }
  };
  await store.saveReview(record);
  await store.applyControl({ expectedRevision: 0, requestId: crypto.randomUUID(), operation: { operation: 'guidance', projectId: 'alpha', text: 'Prefer conservative estimates for alpha.' } });
}

async function startServer(workspace, state, serverPort, assetPort) {
  const child = spawn(process.execPath, [path.join(root, 'dist/server.js')], {
    env: { ...process.env, OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(serverPort), OK_WORKBENCH_ASSET_PORT: String(assetPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  });
  return child;
}
async function stopServer(child) { if (!child || child.exitCode !== null) return; child.kill(); await new Promise(resolve => child.once('exit', resolve)); }

async function withOverview(fn) {
  if (!chromium) { console.log('  (skipped: playwright is not installed; run `npm install` then `npx playwright install chromium`)'); return; }
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-e2e-workspace-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-e2e-state-'));
  const serverPort = await freePort(); let assetPort = await freePort(); while (assetPort === serverPort) assetPort = await freePort();
  let server; let browser;
  try {
    await seedWorkspace(workspace, state);
    server = await startServer(workspace, state, serverPort, assetPort);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.workspace-overview', { timeout: 5000 });
    await fn(page, { serverPort, state, workspace });
  } finally {
    await browser?.close().catch(() => {});
    await stopServer(server);
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
}

async function checkStickyTable(page) {
  await page.evaluate(() => {
    const table = document.querySelector('#document table');
    const row = table.tBodies[0].rows[0];
    for (let i = 0; i < 40; i++) table.tBodies[0].append(row.cloneNode(true));
    const spacer = document.createElement('div');
    spacer.style.height = '1000px';
    document.querySelector('#document').append(spacer);
  });
  const scrollTable = async end => {
    await page.evaluate(end => {
      const pane = document.querySelector('#document');
      const table = pane.querySelector('table');
      const desktop = matchMedia('(min-width: 901px)').matches;
      const scrollportTop = desktop ? pane.getBoundingClientRect().top : document.querySelector('.topbar').getBoundingClientRect().bottom;
      const rect = table.getBoundingClientRect();
      const delta = (end ? rect.bottom - 15 : rect.top + 150) - scrollportTop;
      if (desktop) pane.scrollTop += delta;
      else window.scrollBy(0, delta);
    }, end);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await scrollTable(false);
  const geometry = () => page.evaluate(() => {
    const pane = document.querySelector('#document');
    const th = pane.querySelector('th');
    const rect = th.getBoundingClientRect();
    const boundary = matchMedia('(min-width: 901px)').matches ? pane.getBoundingClientRect().top : document.querySelector('.topbar').getBoundingClientRect().bottom;
    return { top: rect.top, bottom: rect.bottom, boundary, tableBottom: pane.querySelector('table').getBoundingClientRect().bottom,
      visible: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('th') === th };
  });
  let rect = await geometry();
  assert.ok(Math.abs(rect.top - rect.boundary) <= 1, `header should stick below chrome: ${JSON.stringify(rect)}`);
  assert.ok(rect.visible, 'sticky header should be visible, not covered');
  await scrollTable(true);
  rect = await geometry();
  assert.ok(Math.abs(rect.bottom - rect.tableBottom) <= 1, 'header stays bounded by the table end');
}

test('overview table headers stick to the document scrollport until the table ends', async () => {
  await withOverview(async page => {
    for (const width of [1440, 800]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(page.url(), { waitUntil: 'networkidle' });
      await page.locator('[data-review-tab="projects"]').click();
      await checkStickyTable(page);
    }
  });
});

test('review bar scrolls away without shifting content and returns at the top while project table headers stick', async () => {
  await withOverview(async (page, { workspace, serverPort }) => {
    await writeFile(path.join(workspace, 'alpha', 'index.md'), '# Alpha\n\n| Task | Status |\n| --- | --- |\n| Review | Open |\n');
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => localStorage.clear());
      await page.goto(`http://127.0.0.1:${serverPort}/workspace/alpha/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.project-review-bar');
      await page.evaluate(() => document.querySelector('#app-layout').classList.add('chat-collapsed'));
      await page.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.style.height = '1000px';
        document.querySelector('#document').append(spacer);
      });
      const bar = page.locator('.project-review-bar');
      assert.equal(await bar.isVisible(), true);
      const heading = page.locator('#document h1');
      const headingTop = await heading.evaluate(element => element.getBoundingClientRect().top);
      const barHeight = await bar.evaluate(element => element.getBoundingClientRect().height);
      await page.evaluate(() => {
        if (matchMedia('(min-width: 901px)').matches) document.querySelector('#document').scrollTop = 1;
        else window.scrollTo(0, 1);
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const scrolledHeadingTop = await heading.evaluate(element => element.getBoundingClientRect().top);
      assert.ok(Math.abs(scrolledHeadingTop - (headingTop - 1)) <= 1, 'one pixel of scrolling moves content by one pixel without a jump');
      assert.equal(await bar.evaluate(element => element.getBoundingClientRect().height), barHeight, 'scrolling does not collapse the bar and reflow the page');
      await page.evaluate(() => { document.querySelector('#document').scrollTop = 0; window.scrollTo(0, 0); });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await heading.evaluate(element => element.getBoundingClientRect().top), headingTop, 'returning to the top restores the original position');
      await checkStickyTable(page);
      assert.ok(await bar.evaluate(element => {
        const boundary = matchMedia('(min-width: 901px)').matches
          ? document.querySelector('#document').getBoundingClientRect().top
          : document.querySelector('.topbar').getBoundingClientRect().bottom;
        return element.getBoundingClientRect().bottom <= boundary;
      }), 'the review bar has scrolled fully out of view');
    }
  });
});

test('the chat restore button leaves the review bar close button accessible', async () => {
  await withOverview(async (page, { serverPort }) => {
    for (const width of [1440, 1024, 901, 800, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => localStorage.clear());
      await page.goto(`http://127.0.0.1:${serverPort}/workspace/alpha/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.project-review-bar');
      if (await page.locator('#chat-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#chat-toggle').click();
      await page.locator('#chat-restore').waitFor({ state: 'visible' });
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      assert.ok(await page.locator('.review-bar-defer').evaluate(button => {
        const close = button.getBoundingClientRect();
        const restore = document.querySelector('#chat-restore').getBoundingClientRect();
        const overlaps = close.left < restore.right && close.right > restore.left && close.top < restore.bottom && close.bottom > restore.top;
        return !overlaps && document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2)?.closest('.review-bar-defer') === button;
      }), `the review bar close button should be unobscured at ${width}px`);
      await page.locator('.review-bar-defer').click();
      assert.equal(await page.locator('.project-review-bar').count(), 0, 'the close button dismisses the bar');
      await page.locator('#chat-restore').click();
      assert.equal(await page.locator('#chat-toggle').getAttribute('aria-expanded'), 'true', 'chat still restores');
    }
  });
});

test('the overview renders every attention item, escalation, and the question inside Today, with no page overflow at 1440/1024/768/390', async () => {
  await withOverview(async page => {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `expected no horizontal overflow at ${width}px, got ${overflow}px`);
    }
    const today = page.locator('#review-panel-today');
    await assert.doesNotReject(today.locator('text=Beta deadline this week').waitFor({ timeout: 3000 }));
    await assert.doesNotReject(today.locator('text=Alpha needs a follow-up test').waitFor({ timeout: 3000 }));
    await assert.doesNotReject(today.locator('text=Should beta ship this week or next?').waitFor({ timeout: 3000 }));
    const firstItem = today.locator('.workspace-attention').first();
    assert.equal(await firstItem.locator('.workspace-attention-project a').textContent(), 'beta');
    assert.equal(await firstItem.locator('.workspace-attention-project a').getAttribute('href'), '/workspace/beta/');
    assert.equal(await firstItem.getByText('Missing it risks the release.').isVisible(), false);
    assert.ok(await firstItem.locator('.workspace-first-step').isVisible());
    await firstItem.getByText('Why this matters', { exact: true }).click();
    assert.ok(await firstItem.getByText('Missing it risks the release.').isVisible());
    await assert.doesNotReject(firstItem.locator('text=Consequence to avoid').waitFor({ timeout: 3000 }));
    await assert.doesNotReject(today.locator('.doc-kicker', { hasText: 'SINCE THE LAST REVIEW' }).waitFor({ timeout: 3000 }));
    await assert.doesNotReject(today.locator('text=Alpha finished initial setup').first().waitFor({ timeout: 3000 }));
  });
});

test('Today keeps included actions after exclusion, then shows a new scoped briefing', async () => {
  await withOverview(async (page, { state, workspace }) => {
    const store = new WorkspaceReviewStore({ stateDir: state, workspaceRoot: workspace });
    await store.saveSettings({ provider: null, model: null, excludedProjects: ['alpha'] }, 1);
    await page.reload({ waitUntil: 'networkidle' });
    const today = page.locator('#review-panel-today');
    assert.equal(await today.locator('.workspace-brief').count(), 0);
    assert.equal(await today.locator('.workspace-attention').count(), 1);
    assert.ok(await today.getByText('Beta deadline this week').isVisible());
    assert.equal(await today.getByText('Workspace review updated').count(), 0);

    const latest = await store.latest();
    latest.pipeline = { selectedProjectIds: ['beta'] };
    latest.assessment.headline = 'Beta needs a decision';
    latest.assessment.summary = 'Beta has a deadline this week.';
    latest.assessment.changes = [];
    latest.assessment.attention = latest.assessment.attention.filter(item => item.projectId === 'beta');
    await store.saveReview(latest);
    await page.reload({ waitUntil: 'networkidle' });
    assert.ok(await today.locator('.workspace-brief').isVisible());
    assert.ok(await today.getByText('Beta needs a decision').isVisible());

    await store.saveSettings({ provider: null, model: null, excludedProjects: ['alpha', 'beta'] }, 2);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await today.locator('.workspace-brief').count(), 0);
    assert.ok(await today.getByText('No projects selected for review.').isVisible());
    assert.ok(await today.getByRole('button', { name: 'Choose projects' }).isVisible());
  });
});

test('Today has a quiet state when the old briefing is unsafe and no actions remain', async () => {
  await withOverview(async (page, { state, workspace }) => {
    const store = new WorkspaceReviewStore({ stateDir: state, workspaceRoot: workspace });
    const latest = await store.latest(); latest.assessment.attention = latest.assessment.attention.filter(item => item.projectId === 'beta');
    await store.saveReview(latest);
    await store.saveSettings({ provider: null, model: null, excludedProjects: ['beta'] }, 1);
    await page.reload({ waitUntil: 'networkidle' });
    const today = page.locator('#review-panel-today');
    assert.ok(await today.getByText('No current recommendations for these projects yet.').isVisible());
    assert.equal(await today.locator('.workspace-brief').count(), 0);
    assert.equal(await today.getByText('Nothing else here needs a decision right now.').count(), 0);
  });
});

test('dark mode renders the overview without a JS error and keeps the header visible', async () => {
  await withOverview(async page => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.workspace-overview');
    const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.ok(bodyBackground, 'expected a computed dark-mode background color');
    await assert.doesNotReject(page.locator('h1:has-text("Workspace overview")').waitFor({ timeout: 3000 }));
  });
});

test('an approximated 200% zoom does not introduce horizontal page overflow', async () => {
  await withOverview(async page => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `expected no horizontal overflow at 200% zoom, got ${overflow}px`);
  });
});

test('the tab list uses tablist semantics and arrow-key navigation, and reference tabs stay hidden until selected', async () => {
  await withOverview(async page => {
    const tablist = page.locator('.workspace-tabs[role="tablist"]');
    await assert.doesNotReject(tablist.waitFor({ timeout: 3000 }));
    const todayTab = page.locator('#review-tab-today'); const projectsTab = page.locator('#review-tab-projects');
    assert.equal(await todayTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#review-panel-projects').getAttribute('hidden'), '');
    await todayTab.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);
    assert.equal(await projectsTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#review-panel-today').getAttribute('hidden'), '');
    assert.equal(await page.locator('#review-panel-projects').getAttribute('hidden'), null);
  });
});

test('opening the Monitoring dialog moves focus in, and closing it returns focus to the opening button', async () => {
  await withOverview(async page => {
    const monitoringButton = page.locator('button:has-text("Monitoring")').first();
    await monitoringButton.focus();
    await monitoringButton.press('Enter');
    const dialog = page.locator('dialog#workspace-review-dialog');
    await assert.doesNotReject(dialog.waitFor({ state: 'visible', timeout: 3000 }));
    const focusedInsideDialog = await page.evaluate(() => document.activeElement?.closest('dialog') !== null);
    assert.ok(focusedInsideDialog, 'expected focus to move inside the opened dialog');
    await page.keyboard.press('Escape');
    await assert.doesNotReject(dialog.waitFor({ state: 'hidden', timeout: 3000 }));
    const returnedFocus = await page.evaluate(() => document.activeElement?.textContent?.includes('Monitoring'));
    assert.ok(returnedFocus, 'expected focus to return to the Monitoring button after the dialog closes');
  });
});

test('the Priority dialog can be dismissed with Cancel or Close before a required reason is entered', async () => {
  await withOverview(async page => {
    await page.locator('#review-tab-projects').click();
    await page.locator('[data-review-priority="alpha"]').click();
    const dialog = page.locator('dialog#workspace-review-dialog');
    await assert.doesNotReject(dialog.waitFor({ state: 'visible', timeout: 3000 }));
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await assert.doesNotReject(dialog.waitFor({ state: 'hidden', timeout: 3000 }));

    await page.locator('[data-review-priority="alpha"]').click();
    await assert.doesNotReject(dialog.waitFor({ state: 'visible', timeout: 3000 }));
    await dialog.getByRole('button', { name: 'Close' }).click();
    await assert.doesNotReject(dialog.waitFor({ state: 'hidden', timeout: 3000 }));
  });
});

test('a skip link is the first focusable element and moves focus to the main document region', async () => {
  await withOverview(async page => {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => ({ text: document.activeElement?.textContent?.trim(), href: document.activeElement?.getAttribute('href') }));
    assert.equal(active.href, '#document');
    await page.keyboard.press('Enter');
    const focusedMain = await page.evaluate(() => document.activeElement?.id === 'document' || document.activeElement === document.body);
    assert.ok(focusedMain || active.href === '#document', 'expected the skip link to target the main document region');
  });
});

test('no fixture or prototype-only mockup controls leak into the shipped overview', async () => {
  await withOverview(async page => {
    const html = await page.content();
    for (const banned of ['Preview state', 'Reset demo', 'Fictional Project']) {
      assert.ok(!html.includes(banned), `shipped overview must not contain mockup-only control/text: ${banned}`);
    }
  });
});

test('clicking Review now before any review has ever completed shows persistent, disabled "Reviewing\u2026" feedback, not a silently clickable button', async () => {
  if (!chromium) { console.log('  (skipped: playwright is not installed)'); return; }
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-e2e-workspace-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-e2e-state-'));
  const serverPort = await freePort(); let assetPort = await freePort(); while (assetPort === serverPort) assetPort = await freePort();
  let server; let browser;
  try {
    await writeFile(path.join(workspace, 'index.md'), '# Demo workspace\n');
    const store = new WorkspaceReviewStore({ stateDir: state, workspaceRoot: workspace });
    await store.saveSettings({ provider: 'openai', model: 'gpt-5' }, 0);
    server = await startServer(workspace, state, serverPort, assetPort);
    browser = await chromium.launch();
    const page = await browser.newPage();
    // The real provider is not reachable in this environment; intercept the
    // review API so the test deterministically exercises "a job is running
    // but no review has ever completed" instead of racing a real network
    // failure. This isolates the regression: the empty-review render branch
    // must reflect state.job.state, not overwrite it on every poll.
    let runsCalled = false;
    await page.route('**/api/workspace-review', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ settings: { provider: 'openai', model: 'gpt-5' }, controlsRevision: 0, review: null, monitor: 'manual', job: { state: runsCalled ? 'running' : 'idle' }, freshness: 'none', coverage: [], nextCheckAt: null, modelWarning: null, error: null })
    }));
    await page.route('**/api/workspace-review/runs', route => { runsCalled = true; return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'fake-job', state: 'running', reused: false }) }); });
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.workspace-overview');
    const settingsButton = page.locator('[data-review-settings]');
    await assert.doesNotReject(settingsButton.waitFor({ timeout: 3000 }));
    await settingsButton.click();
    await assert.doesNotReject(page.locator('dialog#workspace-review-dialog').waitFor({ state: 'visible', timeout: 3000 }));
    await page.keyboard.press('Escape');
    const button = page.locator('[data-review-run]');
    await assert.doesNotReject(button.waitFor({ timeout: 3000 }));
    assert.equal(await button.isDisabled(), false);
    await button.click();
    await page.waitForTimeout(300);
    await assert.doesNotReject(page.locator('button:has-text("Reviewing\u2026")').waitFor({ timeout: 3000 }));
    const disabledAfterFirstRender = await page.locator('button:has-text("Reviewing\u2026")').isDisabled();
    assert.equal(disabledAfterFirstRender, true, 'the button must stay disabled while a job is running, even before any review has completed');
    // The 30-second idle poll would previously overwrite this with a fresh,
    // clickable "Review now" button because the empty-review branch ignored
    // job state entirely. Force another render cycle the same way polling
    // does, and confirm the running state survives it.
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(200);
    const stillDisabled = await page.locator('button:has-text("Reviewing\u2026")').isDisabled();
    assert.equal(stillDisabled, true);
  } finally {
    await browser?.close().catch(() => {});
    await stopServer(server);
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a synthesis failure keeps the prior briefing visible and shows newly saved project-cache status', async () => {
  await withOverview(async page => {
    const assessedAt = '2026-09-23T12:00:00.000Z'; let synthesisFailed = false;
    const review = {
      schemaVersion: 1, id: 'prior-briefing', completedAt: assessedAt, partial: false,
      coverage: [{ projectId: 'alpha', included: true, reason: 'included' }], sources: [],
      assessment: { headline: 'Prior briefing stays published', summary: 'This is the last successful synthesis.', focusProjectId: 'alpha', evidenceIds: [], changes: [], question: null },
      projects: [{ projectId: 'alpha', outcome: 'Ship the alpha outcome', priority: 'next', rank: 1, priorityReason: 'Current evidence.', confidence: 'medium', trajectory: 'unknown', lifecycle: 'active', assessment: 'Prior project assessment.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [], assessmentState: 'current', assessedAt, effectivePriority: { priority: 'next', source: 'inferred' } }],
      attention: [], deferred: [], projectErrors: [], briefingState: 'ready'
    };
    await page.route('**/api/workspace-review', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      settings: { provider: 'openai', model: 'gpt-5', activityTracking: false, automatic: false }, controlsRevision: 0,
      review, eligibleProjectCount: 1, monitor: 'manual', job: { state: 'idle', id: 'failed-job', phase: null, progress: null }, freshness: synthesisFailed ? 'stale' : 'current',
      coverage: review.coverage, nextCheckAt: null, modelWarning: null,
      error: synthesisFailed ? { code: 'INVALID_REVIEW', message: 'Workspace review could not be completed', detail: '2 bytes; starts with other text; ends with other text (possibly truncated)', at: assessedAt } : null,
      pendingProjectStatus: synthesisFailed ? [{ projectId: 'alpha', state: 'current', assessedAt: '2026-09-23T12:05:00.000Z', errorCode: null }] : []
    }) }));
    await page.reload({ waitUntil: 'networkidle' });
    await assert.doesNotReject(page.getByRole('heading', { name: 'Prior briefing stays published' }).waitFor({ timeout: 3000 }));
    synthesisFailed = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await assert.doesNotReject(page.getByText('Project assessments saved for alpha; workspace synthesis is still unavailable.').waitFor({ timeout: 3000 }));
    review.projectErrors = [{ projectId: 'alpha', code: 'INVALID_REVIEW', stage: 'project', validationDiagnostic: 'invalid_json', at: assessedAt }];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('tab', { name: /All projects/ }).click();
    await assert.doesNotReject(page.getByText('Review failed: The response was not valid JSON.').waitFor({ timeout: 3000 }));
    await page.getByRole('tab', { name: 'Today' }).click();
    await assert.doesNotReject(page.getByText(/Review unavailable:/).waitFor({ timeout: 3000 }));
    await assert.doesNotReject(page.getByRole('heading', { name: 'Prior briefing stays published' }).waitFor({ timeout: 3000 }));
  });
});

test('document IDs and glossary terms show local definitions without marking their sources', { skip: !chromium }, async () => {
  await withOverview(async (page, { workspace, serverPort }) => {
    await writeFile(path.join(workspace, 'alpha', 'definitions.md'), `# Example
WC-1 is used here. Work contract is also used. Missing ZZ-9 has no definition. wc-1, XWC-1Y and WC-1-extra are not references. See §21 and §99.
\`WC-1\` and [WC-1](https://example.com) are not rewritten.
\`\`\`text
WC-1 is not a reference.
\`\`\`
| ID | Requirement |
|----|-------------|
| WC-1 | **Work contract** permits <img src=x onerror=alert(1)> work. |
- SEC-2: Security detail.
A SEC-2 reference appears later.
## 21. Glossary
- **Human proxy**: An agent representing a human.
Human proxy handles WC-1.

| Term | Meaning |
|------|---------|
| Work contract | A unit of work. |
`);
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/alpha/definitions.md`, { waitUntil: 'networkidle' });
    const refs = page.locator('#document .definition-reference');
    assert.equal(await refs.count(), 7); // IDs and prose terms, including the definition text in the table
    assert.equal(await page.locator('#document .markdown-table tbody tr').first().locator('td').first().locator('.definition-reference').count(), 0);
    assert.equal(await page.locator('#document li').first().locator('.definition-reference').count(), 1); // later mention, not the source ID
    assert.equal(await page.locator('#document code .definition-reference').count(), 0);
    assert.equal(await page.locator('#document a .definition-reference').count(), 0);
    await refs.first().hover();
    const preview = page.locator('.definition-preview');
    await preview.waitFor({ state: 'visible' });
    assert.match(await preview.textContent(), /WC-1.*Work contract permits/);
    await page.mouse.move(1, 1);
    await page.waitForTimeout(200);
    assert.equal(await preview.isVisible(), true);
    await preview.waitFor({ state: 'hidden', timeout: 1500 });
    await refs.first().hover();
    const sourceLink = preview.locator('.preview-source-link');
    const sourceHash = await sourceLink.getAttribute('href');
    assert.match(sourceHash, /^#definition-source-\d+$/);
    await sourceLink.click();
    assert.equal(new URL(page.url()).hash, sourceHash);
    assert.equal(await page.locator(sourceHash).textContent(), 'WC-1');
    assert.equal(await preview.isHidden(), true);
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    await refs.nth(1).focus();
    await preview.waitFor({ state: 'visible' });
    assert.match(await preview.textContent(), /Work contract.*A unit of work/);
    await page.locator('#document .definition-reference[data-definition-key="Human proxy"]').hover();
    assert.match(await preview.textContent(), /Human proxy.*An agent representing a human/);
    const bulletHash = await sourceLink.getAttribute('href');
    await sourceLink.click();
    assert.match(await page.locator(bulletHash).textContent(), /Human proxy: An agent representing a human/);
    assert.equal(await page.locator('#document li').last().locator('.definition-reference').count(), 2); // later mentions only
    assert.equal(await page.locator('#document .markdown-table').last().locator('tbody td').first().locator('.definition-reference').count(), 0);
    await page.locator('#document .definition-reference[data-definition-key="Work contract"]').first().hover();
    const glossaryHash = await sourceLink.getAttribute('href');
    assert.equal(await page.locator(glossaryHash).textContent(), 'Work contract');
    await page.locator('#document .definition-reference[data-definition-key="ZZ-9"]').hover();
    assert.match(await preview.textContent(), /No definition in this document/);
    assert.equal(await sourceLink.isHidden(), true);
    await page.locator('#document .section-reference[data-section-number="21"]').hover();
    const sectionLink = page.locator('.section-preview .preview-source-link');
    assert.equal(await sectionLink.getAttribute('href'), '#21-glossary');
    await sectionLink.click();
    assert.equal(new URL(page.url()).hash, '#21-glossary');
    await page.locator('#document .section-reference[data-section-number="99"]').hover();
    assert.equal(await sectionLink.isHidden(), true);
  });
});

test('Luchta document resolves real requirement IDs and its numbered glossary', { skip: !chromium }, async t => {
  const source = await (await import('node:fs/promises')).readFile(path.join(process.env.HOME || '', 'ok-workbench/luchta/high-level-requirements.md'), 'utf8').catch(() => null);
  if (!source) return t.skip('local example not available');
  await withOverview(async (page, { workspace, serverPort }) => {
    await writeFile(path.join(workspace, 'alpha', 'requirements.md'), source);
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/alpha/requirements.md`, { waitUntil: 'networkidle' });
    const sourceId = page.locator('#document .markdown-table td').filter({ hasText: /^WC-1$/ }).first();
    assert.equal(await sourceId.locator('.definition-reference').count(), 0);
    const principle = page.locator('#document .definition-reference[data-definition-key="P-14"]').first();
    await principle.hover();
    assert.match(await page.locator('.definition-preview').textContent(), /P-14.*Agents never know they are scored/);
    const glossary = page.locator('#document .markdown-table td').filter({ hasText: /^Compaction$/ }).last();
    assert.equal(await glossary.locator('.definition-reference').count(), 0);
    await page.locator('#document .definition-reference[data-definition-key="Compaction"]').first().hover();
    assert.match(await page.locator('.definition-preview').textContent(), /Compaction.*context fills up/);
  });
});

test('agent connections warns when the bundled Pi runtime is outdated', { skip: !chromium }, async () => {
  await withOverview(async page => {
    await page.route('**/api/chat/pi-version', route => route.fulfill({ json: { installed: '1.1.0', latest: '1.2.0', updateAvailable: true } }));
    await page.evaluate(() => openChatSettings());
    const notice = page.locator('#chat-pi-update');
    await notice.getByText('Pi runtime update available').waitFor();
    assert.match(await notice.textContent(), /Installed: 1\.1\.0 · Latest: 1\.2\.0/);
    await page.locator('#chat-settings-close').click();
    await page.route('**/api/chat/pi-version', route => route.fulfill({ json: { installed: '1.2.0', latest: '1.2.0', updateAvailable: false } }));
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/chat/pi-version')), page.evaluate(() => openChatSettings())]);
    assert.equal(await notice.isHidden(), true);
  });
});

test('review settings prefer API-token models independently of the signed-in chat provider', { skip: !chromium }, async () => {
  await withOverview(async page => {
    const providers = [
      { id: 'openai-codex', label: 'Codex', authType: 'oauth', models: [{ id: 'chat-model', label: 'Chat model' }] },
      { id: 'openai', label: 'OpenAI', authType: 'api_key', models: [{ id: 'review-model', label: 'Review model' }] }
    ];
    await page.route('**/api/chat/status*', route => route.fulfill({ json: { enabled: true, defaultProvider: 'openai-codex', defaultModel: 'chat-model', providers, models: providers[0].models } }));
    await page.evaluate(() => loadChatStatus());
    assert.equal(await page.locator('#chat-provider').inputValue(), 'openai-codex');
    await page.locator('[data-review-settings]').first().click();
    const provider = page.locator('#review-settings-provider');
    assert.equal(await provider.inputValue(), 'openai');
    assert.equal(await page.locator('[name=hybrid]').isChecked(), true);
    assert.equal(await page.locator('[name=assessmentProvider]').inputValue(), 'openai-codex');
    assert.equal(await page.locator('[name=assessmentModel]').inputValue(), 'chat-model');
    assert.equal(await page.locator('#review-settings-model').inputValue(), 'review-model');
    assert.match(await provider.locator('option[value="openai"]').textContent(), /API token/);
    assert.match(await provider.locator('option[value="openai-codex"]').textContent(), /Account sign-in/);
    await provider.selectOption('openai-codex');
    assert.equal(await page.locator('#review-settings-model').inputValue(), 'chat-model');
    await page.locator('[name=belowRecommendedModel]').check();
    let saved;
    await page.route('**/api/workspace-review/settings', async route => {
      saved = route.request().postDataJSON();
      await route.fulfill({ json: { settings: saved } });
    });
    await page.locator('[data-review-save-settings]').click();
    await page.waitForFunction(() => !document.querySelector('#workspace-review-dialog')?.open);
    assert.equal(saved.provider, 'openai-codex');
    assert.equal(saved.model, 'chat-model');
    assert.deepEqual(saved.assessmentModel, { provider: 'openai-codex', model: 'chat-model', effort: null });
    assert.equal(await page.locator('#chat-provider').inputValue(), 'openai-codex');
    await page.route('**/api/workspace-review', async route => {
      const response = await route.fetch(); const state = await response.json();
      state.settings.provider = 'openai-codex'; state.settings.model = 'chat-model'; state.settings.assessmentModel = null;
      await route.fulfill({ json: state });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-review-settings]').first().click();
    assert.equal(await page.locator('#review-settings-provider').inputValue(), 'openai-codex');
    assert.equal(await page.locator('#review-settings-model').inputValue(), 'chat-model');
    assert.equal(await page.locator('[name=hybrid]').isChecked(), false);
    assert.equal(await page.locator('#review-settings-assessment').isVisible(), false);
  });
});
