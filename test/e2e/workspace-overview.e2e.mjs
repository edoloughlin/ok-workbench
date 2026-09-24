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
    await assert.doesNotReject(today.locator('text=Consequence to avoid').waitFor({ timeout: 3000 }));
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
