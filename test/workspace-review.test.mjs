import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkspaceReviewStore } = require('../src/workspace-review-store.js');
const { runway, publicReview, validateReview } = require('../src/workspace-review-schema.js');
const { parseReviewJSON } = require('../src/workspace-review-pipeline.js');
const { WorkspaceReviewCoordinator, collectEvidence, reviewCoveragePrompt, reportLogHistory, annotateAttentionRecurrence, reviewModelTier, reviewContextTokensRequired, RESPONSE_LIMIT, unwrapJsonFence } = require('../src/workspace-review.js');

function stagedLegacyProvider(provider) {
  return async request => {
    const rawEvidence = request.evidence;
    const projects = request.stage === 'project'
      ? [{ id: request.projectId, sources: rawEvidence.sources }]
      : (rawEvidence.projects || []).map(item => ({ id: item.projectId, sources: item.sources }));
    const sources = request.stage === 'project' ? rawEvidence.sources : (rawEvidence.projects || []).flatMap(item => item.sources || []);
    const evidence = { ...rawEvidence, projects, sources, workspace: rawEvidence.workspace || [] };
    const response = await provider({ ...request, evidence });
    if (typeof response !== 'string') return response;
    let full; try { full = JSON.parse(unwrapJsonFence(response)); } catch { return response; }
    if (request.stage === 'project') {
      const project = full.projects?.find(item => item.projectId === request.projectId);
      if (!project) return response;
      const { priority, rank, priorityReason, ...assessment } = project;
      return JSON.stringify({ assessment, attentionCandidates: (full.attention || []).filter(item => item.projectId === request.projectId) });
    }
    return JSON.stringify({ headline: full.headline, summary: full.summary, focusProjectId: full.focusProjectId, evidenceIds: full.evidenceIds, changes: full.changes, priorities: (full.projects || []).map(({ projectId, priority, rank, priorityReason }) => ({ projectId, priority, rank, priorityReason })), attention: full.attention, question: full.question });
  };
}

test('review text lengths allow 20% beyond the prompt targets, but no more', () => {
  const source = { id: 'source', projectId: 'alpha', excerpt: 'Evidence.' };
  const raw = {
    headline: 'H'.repeat(192), summary: 'S'.repeat(720), focusProjectId: null,
    evidenceIds: ['source'], changes: [],
    projects: [{ projectId: 'alpha', priority: 'maintain', rank: 1, priorityReason: 'Reason', confidence: 'medium', trajectory: 'unknown', lifecycle: 'active', outcome: 'Outcome', assessment: 'Assessment', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Reason', evidenceIds: ['source'], claimEvidence: [] }],
    attention: [], question: null
  };
  const context = { projects: [{ id: 'alpha' }], sources: [source] };
  assert.equal(validateReview(raw, context).headline.length, 192);
  raw.headline += 'H';
  assert.throws(() => validateReview(raw, context), /headline must be 1 to 192 plain-text characters/);
  raw.headline = 'Headline'; raw.summary += 'S';
  assert.throws(() => validateReview(raw, context), /summary must be 1 to 720 plain-text characters/);
});

test('workspace review state is isolated by canonical workspace root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    const first = new WorkspaceReviewStore({ stateDir: root, workspaceRoot: '/one' });
    const second = new WorkspaceReviewStore({ stateDir: root, workspaceRoot: '/two' });
    await first.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    assert.equal((await first.settings()).model, 'reviewer');
    assert.equal((await second.settings()).model, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project cache pruning requires 30 continuous days of ineligibility', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-cache-retention-')); const store = new WorkspaceReviewStore({ stateDir: root, workspaceRoot: '/retention' });
  try {
    await store.saveProjectAssessment({ schemaVersion: 1, projectId: 'alpha', inputKey: 'key', resultDigest: 'digest', assessedAt: '2026-09-01T00:00:00.000Z', nextDueAt: '2026-09-08T00:00:00.000Z', provider: 'openai', model: 'reviewer', effort: null, versions: { collector: 1 }, result: {}, sources: [], coverage: {} });
    await store.reconcileProjectEligibility([], new Date('2026-09-01T00:00:00Z'));
    assert.equal((await store.projectAssessment('alpha')).ineligibleSince, '2026-09-01T00:00:00.000Z');
    await store.reconcileProjectEligibility([], new Date('2026-09-30T23:59:59Z'));
    assert.ok(await store.projectAssessment('alpha'), 'cache remains during the 30-day retention window');
    await store.reconcileProjectEligibility(['alpha'], new Date('2026-10-01T00:00:00Z'));
    assert.equal((await store.projectAssessment('alpha')).ineligibleSince, undefined, 'eligibility resets the continuous-ineligible clock');
    await store.reconcileProjectEligibility([], new Date('2026-10-01T00:00:01Z'));
    await store.reconcileProjectEligibility([], new Date('2026-10-31T00:00:00Z'));
    assert.equal((await store.projectAssessment('alpha')).projectId, 'alpha');
    await store.reconcileProjectEligibility([], new Date('2026-10-31T00:00:02Z'));
    assert.equal(await store.projectAssessment('alpha'), null, 'cache is pruned after 30 uninterrupted ineligible days');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run is single-flight and returns a job before a provider result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    let rejectProvider; let providerCalls = 0; const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => { providerCalls++; if (providerCalls > 1) throw new Error('offline'); return new Promise((resolve, reject) => { rejectProvider = reject; }); } });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    const first = await coordinator.run(); const second = await coordinator.run();
    assert.equal(first.state, 'running'); assert.equal(second.state, 'running'); assert.equal(second.reused, true); assert.equal(first.jobId, second.jobId);
    const task = coordinator.running.task; for (let index = 0; index < 500 && !rejectProvider; index++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(typeof rejectProvider, 'function'); rejectProvider(new Error('offline')); await task;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('normal review logs include an ISO timestamp and request and response byte sizes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  const logged = []; const original = console.log; console.log = (...args) => logged.push(args.join(' '));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n');
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => '{}' });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task.catch(() => {});
    const request = logged.find(entry => entry.includes('workspace review project alpha requesting model;'));
    const response = logged.find(entry => entry.includes('workspace review project alpha model response received;'));
    assert.match(request, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ok-workbench\] workspace review /);
    assert.match(request, /promptBytes=\d+, evidenceBytes=\d+, inputBytes=\d+/);
    assert.match(response, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ok-workbench\] workspace review /);
    assert.match(response, /responseBytes=2/);
  } finally { console.log = original; await rm(root, { recursive: true, force: true }); }
});

test('a single Markdown-fenced JSON object is unwrapped, but prose and partial fences are left untouched', () => {
  assert.equal(unwrapJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unwrapJsonFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unwrapJsonFence('{"a":1}'), '{"a":1}');
  // Prose around a fenced block, or a fence that is not the entire response,
  // must not be touched: that would be the prohibited "extract JSON from
  // prose" behavior, not normalization of a known wrapper.
  assert.equal(unwrapJsonFence('Here you go:\n```json\n{"a":1}\n```'), 'Here you go:\n```json\n{"a":1}\n```');
  assert.equal(unwrapJsonFence('```json\n{"a":1}\n```\nLet me know if you need changes.'), '```json\n{"a":1}\n```\nLet me know if you need changes.');
});

test('a model response fenced entirely in Markdown still produces a valid, published review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\nLast completed: setup.\n');
    const coordinator = new WorkspaceReviewCoordinator({
      stateDir: root, workspaceRoot: root,
      provider: stagedLegacyProvider(async ({ evidence }) => {
        const statusId = evidence.projects[0].sources.find(source => source.path === 'status.md').id;
        const body = { headline: 'Alpha is steady', summary: 'On course.', focusProjectId: 'alpha', evidenceIds: [statusId], changes: [], projects: [{ projectId: 'alpha', priority: 'maintain', rank: 1, priorityReason: 'Stable', confidence: 'high', trajectory: 'on_course', lifecycle: 'active', outcome: 'Ship alpha', assessment: 'On course', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Stable', evidenceIds: [statusId], claimEvidence: [] }], attention: [], question: null };
        return `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;
      })
    });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    const state = await coordinator.state();
    assert.equal(state.error, null); assert.ok(state.review, 'a fenced-JSON response should still be validated and published');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a non-JSON response is rejected with a bounded head/tail preview in the server log only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  const logged = []; const original = console.error; console.error = (...args) => logged.push(args.join(' '));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n');
    const secret = 'MIDDLE-OF-RESPONSE-NEVER-LOGGED'.repeat(20);
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
      if (request.stage === 'project') return `Here is the review:\n{"headline": "${secret}"}\nLet me know if you need changes.`;
      const sourceId = request.evidence.projects[0].sources[0].id;
      return JSON.stringify({ headline: 'Workspace review', summary: 'One assessment is unavailable.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: request.evidence.projects.map((project, index) => ({ projectId: project.projectId, priority: 'maintain', rank: index + 1, priorityReason: 'Insufficient evidence.' })), attention: [], question: null });
    } });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    const state = await coordinator.state();
    assert.equal(state.error, null);
    // The persisted detail is a content-free shape summary: it distinguishes
    // an empty, truncated, and prose-wrapped reply without echoing model text.
    const error = state.review.projectErrors.find(item => item.projectId === 'alpha');
    assert.equal(error.code, 'INVALID_REVIEW'); assert.equal(error.stage, 'project'); assert.equal(error.projectId, 'alpha'); assert.ok(error.at);
    assert.equal(error.validationDiagnostic, 'invalid_json_invalid_character');
    assert.match(error.responseShape, /^\d+ bytes; starts with other text; ends with other text \(possibly truncated\)$/);
    assert.ok(!error.responseShape.includes('Here is the review'), 'the persisted shape never echoes response text');
    const rejection = logged.find(entry => entry.includes('workspace review rejected (unparsable project JSON'));
    assert.ok(rejection, 'the failed stage is logged for the operator');
    assert.ok(rejection.includes('response head/tail'));
    assert.ok(!JSON.stringify(state).includes('Here is the review'), 'the raw response never reaches the client state');
  } finally { console.error = original; await rm(root, { recursive: true, force: true }); }
});

test('provider-supplied error codes and messages are normalized before persistence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-safe-error-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
      if (request.stage === 'project') { const error = new Error('secret-provider-response'); error.code = 'LEAK_THIS_CODE'; throw error; }
      const project = request.evidence.projects[0]; const gap = project.sources.find(source => source.generated);
      assert.ok(gap, 'cold project failure gets a generated evidence-gap source');
      assert.equal(gap.path, null); assert.equal(gap.reason, undefined, 'the bounded model projection omits internal source reason');
      return JSON.stringify({ headline: 'Evidence unavailable', summary: 'A current project assessment could not be obtained.', focusProjectId: null, evidenceIds: [gap.id], changes: [], priorities: [{ projectId: 'alpha', priority: 'maintain', rank: 1, priorityReason: 'Evidence is unavailable.' }], attention: [], question: null });
    } });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    const runtime = await coordinator.store.runtime(); const state = await coordinator.state();
    assert.equal(runtime.lastJob.state, 'completed');
    const projectError = state.review.projectErrors.find(item => item.projectId === 'alpha');
    assert.deepEqual(Object.keys(projectError).sort(), ['at', 'code', 'projectId', 'stage']);
    assert.equal(projectError.code, 'PROVIDER_UNAVAILABLE'); assert.equal(projectError.stage, 'project'); assert.ok(projectError.at);
    assert.ok(!JSON.stringify(runtime).includes('secret-provider-response'));
    assert.ok(!JSON.stringify(state).includes('LEAK_THIS_CODE'));
    assert.ok(state.review.sources.some(source => source.generated && source.path === null), 'public review retains the generated gap source');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a manual Codex review corrects one invalid candidate within the same job', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha'));
    await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n');
    await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\nWork is active.\n');
    let calls = 0; let rejectedCandidate = null;
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async ({ stage, evidence }) => {
      calls++;
      if (stage === 'project') {
        if (calls === 2) {
          assert.equal(evidence.priorCandidate, rejectedCandidate, 'the correction receives the rejected structured response');
          assert.match(evidence.validationFeedback, /non-active lifecycle needs supporting claimEvidence/);
        }
        const sourceId = evidence.sources.find(source => source.path === 'status.md').id;
        const response = JSON.stringify({ assessment: { projectId: 'alpha', confidence: 'medium', trajectory: 'unknown', lifecycle: calls === 1 ? 'waiting' : 'active', outcome: 'Finish alpha', assessment: 'Status needs review', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Check weekly', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] });
        if (calls === 1) rejectedCandidate = response;
        return response;
      }
      const sourceId = evidence.projects[0].sources.find(source => source.path === 'status.md').id;
      return JSON.stringify({ headline: 'Alpha review', summary: 'Review alpha', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: [{ projectId: 'alpha', priority: 'next', rank: 1, priorityReason: 'Active work' }], attention: [], question: null });
    } });
    await coordinator.store.saveSettings({ provider: 'openai-codex', model: 'gpt-5.6-terra' }, 0);
    await coordinator.run('manual'); await coordinator.running.task;
    assert.equal(calls, 3);
    assert.equal((await coordinator.state()).review?.projects[0].lifecycle, 'active');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a manual Codex review stops after one unsuccessful correction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha'));
    await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n');
    await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    let calls = 0;
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => { calls++; return '{}'; } });
    await coordinator.store.saveSettings({ provider: 'openai-codex', model: 'gpt-5.6-terra' }, 0);
    await coordinator.run('manual'); await coordinator.running.task;
    assert.equal(calls, 4);
    assert.equal((await coordinator.state()).error?.code, 'INVALID_REVIEW');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automatic Codex reviews do not make an uncounted correction call', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha'));
    await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n');
    await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    let calls = 0;
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => { calls++; return '{}'; } });
    await coordinator.store.saveSettings({ provider: 'openai-codex', model: 'gpt-5.6-terra', automatic: true }, 0);
    await coordinator.run('automatic'); await coordinator.running.task;
    assert.equal(calls, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an oversized provider response is rejected without being parsed or published', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    const oversized = 'x'.repeat(64 * 1024 + 1);
    let calls = 0;
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => { calls++; return oversized; } });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    const state = await coordinator.state(); assert.equal(state.review, null); assert.equal(state.error.code, 'RESPONSE_TOO_LARGE'); assert.equal(calls, 2, 'oversized responses are not corrected');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('JSON recovery preserves content and rejects ambiguous or incomplete responses', () => {
  const original = { text: 'Escaped "quote", backslash \\, braces } ] and { inside text', nested: [{ value: null }] };
  const json = JSON.stringify(original);
  assert.deepEqual(parseReviewJSON(json), { raw: original, recovery: null });
  for (const suffix of ['}', '}}', ']', '"', ' }\n ] " ']) {
    assert.deepEqual(parseReviewJSON(` \n${json}${suffix}`).raw, original);
    assert.ok(parseReviewJSON(json + suffix).recovery);
  }
  for (const invalid of [json + ' prose', json + '{}', json + 'null', json + '","injected":true}', json.slice(0, -1), '{"a":1,}}', '{"a":"unterminated}', '[]}', json + '}'.repeat(9)]) {
    assert.throws(() => parseReviewJSON(invalid), SyntaxError, invalid);
  }
});

test('staged refresh recovers trailing punctuation, validates recovered objects, and bounds corrections', async () => {
  const cases = ['fenced', 'malformed', 'prose', 'oversized', 'extra-brace', 'extra-quote', 'schema-with-suffix', 'chained-first-step'];
  for (const mode of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `ok-workbench-review-force-${mode}-`)); const calls = []; let projectAttempts = 0;
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
      calls.push({ stage: request.stage, projectId: request.projectId, attemptNumber: request.attemptNumber, feedback: request.evidence.validationFeedback });
      if (request.stage === 'project') {
        projectAttempts++;
        if (mode === 'oversized') return 'x'.repeat(16 * 1024 + 1);
        if ((mode === 'malformed' || mode === 'prose') && projectAttempts === 1) return mode === 'malformed' ? '{' : 'Here is the assessment: {"assessment":{}}';
        const sourceId = request.evidence.sources.find(source => source.path === 'status.md').id;
        const raw = { assessment: { projectId: request.projectId, confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: 'Review alpha', assessment: 'Current evidence is available.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Review weekly.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] };
        if (mode === 'schema-with-suffix' && projectAttempts === 1) raw.assessment.projectId = 'wrong-project';
        if (mode === 'chained-first-step') raw.attentionCandidates.push({ projectId: request.projectId, kind: 'update', topic: 'Status', urgency: 'watch', title: 'Record status', observation: 'Evidence exists.', inference: 'A note would help.', action: 'Record the status.', firstStep: projectAttempts === 1 ? 'Open status.md and mark the current status.' : 'Mark the current status in status.md.', evidenceIds: [sourceId], dueDate: null, dueDateEvidence: null, claimEvidence: [] });
        const body = JSON.stringify(raw);
        return mode === 'fenced' ? `\`\`\`json\n${body}\n\`\`\`` : body + (mode === 'extra-quote' ? '"' : ['extra-brace', 'schema-with-suffix', 'chained-first-step'].includes(mode) ? '}' : '');
      }
      const projects = request.evidence.projects; const sourceId = request.evidence.workspace?.[0]?.id || projects.find(project => project.state === 'current')?.sources[0]?.id;
      return JSON.stringify({ headline: 'Current review', summary: 'Current evidence is available.', focusProjectId: null, evidenceIds: sourceId ? [sourceId] : [], changes: [], priorities: projects.map((item, rank) => ({ projectId: item.projectId, priority: 'maintain', rank: rank + 1, priorityReason: 'Review current evidence.' })), attention: [], question: null }) + (mode === 'extra-brace' ? '}' : mode === 'extra-quote' ? '"' : '');
    } });
    // Exercise trace persistence without leaving a five-day expiry worker
    // racing the temporary workspace teardown.
    coordinator.store.startTraceCleaner = () => {};
    try {
      await writeFile(path.join(root, 'index.md'), '# Workspace\n');
      await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
      await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
      await coordinator.run('manual', { force: true }); await coordinator.running.task;
      const projectCalls = calls.filter(call => call.stage === 'project');
      const expectedProjectAttempts = ['malformed', 'prose', 'schema-with-suffix', 'chained-first-step'].includes(mode) ? 2 : 1;
      assert.equal(projectCalls.length, expectedProjectAttempts, `${mode}: project correction count`);
      assert.equal(calls.filter(call => call.stage === 'synthesis').length, 1, `${mode}: synthesis should not need correction`);
      if (mode !== 'oversized') {
        assert.ok(await coordinator.store.projectAssessment('alpha'), `${mode}: valid corrected result is cached`);
        assert.ok((await coordinator.state()).review, `${mode}: valid synthesis is published`);
      } else {
        assert.equal(await coordinator.store.projectAssessment('alpha'), null, 'oversized rejected output is never cached');
        assert.equal((await coordinator.state()).review.partial, true, 'oversized result yields an explicit unavailable project fallback');
      }
      const persisted = JSON.stringify({ latest: await coordinator.store.latest(), runtime: await coordinator.store.runtime(), cache: await coordinator.store.projectAssessment('alpha') });
      assert.ok(!persisted.includes('priorCandidate'));
      if (mode === 'oversized') assert.ok(!persisted.includes('x'.repeat(100)));
      if (mode === 'chained-first-step') assert.match(projectCalls[1].feedback, /firstStep.*Open status.md and mark/);
      if (mode === 'schema-with-suffix') assert.match(projectCalls[1].feedback, /must match requested project/);
      if (mode === 'extra-brace') {
        const traceRoot = coordinator.store.traceDirectory();
        const directories = (await readdir(traceRoot)).filter(name => /^[a-f0-9]{64}$/.test(name));
        const traces = [];
        for (const directory of directories) {
          for (const file of await readdir(path.join(traceRoot, directory))) {
            if (file.endsWith('.json')) traces.push(JSON.parse(await readFile(path.join(traceRoot, directory, file), 'utf8')));
          }
        }
        assert.equal(traces.length, 2, 'both stage responses are retained');
        for (const trace of traces) {
          assert.equal(trace.failure.recovery, 'removed_trailing_punctuation');
          assert.equal(trace.failure.diagnostic, 'invalid_json_extra_closing_brace');
          assert.match(trace.failure.message, /schema validation is still required/);
          assert.ok(trace.response.endsWith('}}'), 'original response is preserved');
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('date runway uses the workspace timezone and floors urgency without mutating stored model urgency', () => {
  const now = new Date('2026-09-21T22:30:00Z'); // 23:30 in Dublin daylight time
  const due = runway('2026-09-21', now, 'Europe/Dublin');
  assert.equal(due.label, 'Due today');
  const tomorrow = runway('2026-09-22', now, 'Europe/Dublin');
  assert.equal(tomorrow.urgency, 'now');
  assert.equal(due.urgency, 'now');
  const record = { assessment: { projects: [{ projectId: 'alpha', priority: 'next', rank: 1 }], attention: [{ id: 'issue', projectId: 'alpha', urgency: 'watch', dueDate: '2026-09-22', evidenceSignature: 'sig' }] } };
  const view = publicReview(record, {}, { now, timeZone: 'Europe/Dublin' });
  assert.equal(view.attention[0].urgency, 'now');
  assert.equal(record.assessment.attention[0].urgency, 'watch');
});

test('collector refuses Markdown behind a symlinked directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-')); const outside = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-outside-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '[Secret](linked/secret.md)\n'); await mkdir(path.join(outside, 'linked')); await writeFile(path.join(outside, 'linked', 'secret.md'), 'outside evidence'); await symlink(path.join(outside, 'linked'), path.join(root, 'alpha', 'linked'));
    const evidence = await collectEvidence(root, {});
    assert.equal(evidence.sources.some(source => source.excerpt.includes('outside evidence')), false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('review discovery excludes cache directories and uses navigation ignore rules', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    for (const id of ['alpha', '__pycache__', 'node_modules', 'ignored']) await mkdir(path.join(root, id));
    const evidence = await collectEvidence(root, {}, new Date(), null, null, file => file === path.join(root, 'ignored'));
    assert.deepEqual(evidence.projects.map(project => project.id), ['alpha']);
    assert.deepEqual(evidence.coverage.map(item => item.projectId), ['alpha']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a project without Markdown can receive a cited unknown assessment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha'));
    const evidence = await collectEvidence(root, {});
    const missing = evidence.projects[0].sources[0];
    assert.equal(missing.path, null);
    assert.equal(missing.generated, true);
    assert.equal(evidence.payload.projects[0].sources[0].generated, true);
    const raw = { headline: 'Needs an update', summary: 'No readable project documents were collected.', focusProjectId: null, evidenceIds: [missing.id], changes: [], projects: [{ projectId: 'alpha', priority: 'maintain', rank: 1, priorityReason: 'Insufficient evidence', confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: 'Unknown', assessment: 'No readable project documents were collected.', nextAction: null, blocker: null, cadence: 'monthly', cadenceReason: 'Check for documentation', evidenceIds: [missing.id], claimEvidence: [] }], attention: [], question: null };
    assert.equal(validateReview(raw, evidence).projects[0].lifecycle, 'unknown');
    raw.projects[0].claimEvidence = [{ claim: 'complete', sourceId: missing.id, excerpt: missing.excerpt }];
    assert.throws(() => validateReview(raw, evidence), /claimEvidence excerpt is not in its cited source/);
    // Models commonly put a lifecycle or trajectory label in claim, or cite an
    // ID that was never supplied; each rejection must name the actual problem.
    raw.projects[0].claimEvidence = [{ claim: 'active', sourceId: missing.id, excerpt: 'x' }];
    assert.throws(() => validateReview(raw, evidence), /claimEvidence claim "active" is invalid; claim must be one of waiting, parked, complete, improvement, consequence/);
    raw.projects[0].claimEvidence = [{ claim: 'complete', sourceId: 'not-a-source', excerpt: 'x' }];
    assert.throws(() => validateReview(raw, evidence), /claimEvidence sourceId "not-a-source" is not a supplied source id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review evidence carries the complete project checklist and reports omissions precisely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    for (const id of ['alpha', 'beta']) {
      await mkdir(path.join(root, id));
      await writeFile(path.join(root, id, 'index.md'), `# ${id}\n`);
      await writeFile(path.join(root, id, 'status.md'), '# Status\n');
    }
    const evidence = await collectEvidence(root, {});
    assert.deepEqual(evidence.payload.requiredProjectIds, ['alpha', 'beta']);
    assert.match(reviewCoveragePrompt(2), /exactly 2 projects/);
    const raw = { headline: 'Headline', summary: 'Summary', focusProjectId: null, evidenceIds: [evidence.sources[0].id], changes: [], projects: [], attention: [], question: null };
    assert.throws(() => validateReview(raw, evidence), /exactly 2 items; received 0/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the app-state directory is never treated as a reviewable project, even nested inside the workspace root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    // The state directory and workspace root coincide here, the most
    // adversarial nesting case: the store's own `workspace-review/` subtree
    // must never surface as a discovered project.
    const store = new WorkspaceReviewStore({ stateDir: root, workspaceRoot: root });
    await store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    const evidence = await collectEvidence(root, {}, new Date(), null, root);
    assert.deepEqual(evidence.projects.map(item => item.id), ['alpha']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('saved assessment becomes stale when bounded evidence changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\nCurrent state\n');
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => '{}' }); await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    const evidence = await collectEvidence(root, {}, new Date(), null, root); await coordinator.store.saveReview({ schemaVersion: 1, inputFingerprint: evidence.fingerprint, completedAt: '2026-09-21T10:00:00Z', sources: evidence.sources, coverage: evidence.coverage, assessment: { projects: [{ projectId: 'alpha', priority: 'next', rank: 1, trajectory: 'unknown', lifecycle: 'active' }], attention: [] } });
    assert.equal((await coordinator.state()).freshness, 'current');
    await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\nChanged state\n');
    const state = await coordinator.state(); assert.equal(state.freshness, 'stale'); assert.equal(state.review.projects[0].evidenceState, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('excluding a project immediately redacts its cached review findings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await mkdir(path.join(root, 'beta')); for (const project of ['alpha', 'beta']) { await writeFile(path.join(root, project, 'index.md'), `# ${project}\n`); await writeFile(path.join(root, project, 'status.md'), '# Status\n'); }
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => '{}' }); await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    const evidence = await collectEvidence(root, {}); await coordinator.store.saveReview({ schemaVersion: 1, inputFingerprint: evidence.fingerprint, completedAt: '2026-09-21T10:00:00Z', sources: evidence.sources, coverage: evidence.coverage, assessment: { headline: 'alpha-secret headline', summary: 'alpha-secret summary', focusProjectId: 'alpha', question: { projectId: 'alpha', text: 'alpha-secret question', reason: 'reason', options: ['one', 'two'], evidenceIds: [evidence.projects[0].sources[0].id] }, projects: ['alpha', 'beta'].map((projectId, index) => ({ projectId, priority: 'next', rank: index + 1, trajectory: 'unknown', lifecycle: 'active' })), attention: [{ id: 'alpha-item', projectId: 'alpha', urgency: 'soon', evidenceSignature: 'same' }, { id: 'beta-item', projectId: 'beta', urgency: 'soon', evidenceSignature: 'same' }] } });
    await coordinator.settings({ provider: 'openai', model: 'reviewer', excludedProjects: ['alpha'] }, 1); const state = await coordinator.state();
    assert.deepEqual(state.review.projects.map(item => item.projectId), ['beta']); assert.deepEqual(state.review.attention.map(item => item.projectId), ['beta']);
    assert.equal(state.review.assessment.focusProjectId, null); assert.equal(state.review.assessment.question, null);
    assert.ok(!JSON.stringify(state.review.assessment).includes('alpha-secret'), 'top-level synthesis cannot leak excluded-project details');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recurrence escalation is server-computed and declined issues never escalate', () => {
  const issue = { id: 'issue', evidenceSignature: 'same' };
  const previous = { assessment: { attention: [{ ...issue, unactedReviewCount: 2 }] } };
  assert.equal(annotateAttentionRecurrence([issue], previous, {}).at(0).escalation.mode, 'consequence');
  const declined = annotateAttentionRecurrence([issue], previous, { issueFeedback: { dismissed: { issueId: 'issue', evidenceSignature: 'same', action: 'dismiss' } } }).at(0);
  assert.equal(declined.unactedReviewCount, 0); assert.equal(declined.escalation, null);
});

test('a user parked priority becomes the effective lifecycle and sorts after active work', () => {
  const record = { assessment: { projects: [{ projectId: 'alpha', priority: 'focus', rank: 1, lifecycle: 'active' }, { projectId: 'beta', priority: 'focus', rank: 2, lifecycle: 'active' }], attention: [] } };
  const view = publicReview(record, { priorityOverrides: { alpha: { tier: 'parked', expiresAt: null } } });
  assert.equal(view.projects[0].projectId, 'beta'); assert.equal(view.projects[1].effectiveLifecycle, 'parked');
});

test('strip-only dismissal keeps the issue in the overview', () => {
  const record = { assessment: { projects: [{ projectId: 'alpha', priority: 'next', rank: 1, lifecycle: 'active' }], attention: [{ id: 'issue', projectId: 'alpha', urgency: 'soon', evidenceSignature: 'sig' }] } };
  const view = publicReview(record, { issueFeedback: { strip: { issueId: 'issue', evidenceSignature: 'sig', action: 'strip_dismiss' } } });
  assert.equal(view.attention.length, 1); assert.equal(view.attention[0].feedback.action, 'strip_dismiss');
});

test('model review tier is a fixed lookup, never inferred from a model label at runtime', () => {
  assert.equal(reviewModelTier('openai', 'gpt-5'), 'recommended');
  assert.equal(reviewModelTier('anthropic', 'claude-3-5-haiku'), 'unsupported');
  assert.equal(reviewModelTier('some-provider', 'a-brand-new-model-nobody-has-scored'), 'unverified');
  // A model whose label merely resembles a small/fast model must not be
  // downgraded by name-pattern guessing; only the fixed table can do that.
  assert.equal(reviewModelTier('some-provider', 'gigantic-flagship-mini-max'), 'unverified');
});

test('the context-fit gate is computed arithmetically from the whole-input and response budgets', () => {
  const required = reviewContextTokensRequired();
  assert.ok(required > 80_000 && required < 100_000, 'required token estimate should reflect the 256 KiB input plus 64 KiB response budget');
  assert.equal(RESPONSE_LIMIT, 64 * 1024);
});

test('a future snooze moves an item to deferred and past snooze restores it to attention', () => {
  const record = { assessment: { projects: [{ projectId: 'alpha', priority: 'next', rank: 1, lifecycle: 'active' }], attention: [{ id: 'issue', projectId: 'alpha', urgency: 'soon', title: 'Snoozed item', evidenceSignature: 'sig' }] } };
  const future = new Date(Date.now() + 86400000).toISOString();
  const deferredView = publicReview(record, { issueFeedback: { snooze: { id: 'fb1', issueId: 'issue', evidenceSignature: 'sig', action: 'snooze', until: future } } });
  assert.equal(deferredView.attention.length, 0); assert.equal(deferredView.deferred.length, 1); assert.equal(deferredView.deferred[0].feedback.id, 'fb1');
  const past = new Date(Date.now() - 1000).toISOString();
  const restoredView = publicReview(record, { issueFeedback: { snooze: { id: 'fb1', issueId: 'issue', evidenceSignature: 'sig', action: 'snooze', until: past } } });
  assert.equal(restoredView.attention.length, 1); assert.equal(restoredView.deferred.length, 0);
});

test('two invalid outputs surface a model warning without disabling manual setup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => '{}' }); await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true }, 0);
    await coordinator.store.updateRuntime(runtime => { runtime.invalidReviewStreak['openai/reviewer'] = 2; return runtime; });
    assert.match((await coordinator.state()).modelWarning, /could not be parsed or validated/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review retention keeps records by completion time rather than UUID filename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    const store = new WorkspaceReviewStore({ stateDir: root, workspaceRoot: '/workspace' });
    for (let index = 0; index < 31; index++) await store.saveReview({ schemaVersion: 1, id: `z-${String(31 - index).padStart(2, '0')}`, completedAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z` });
    const names = await readdir(path.join(store.root, 'history'));
    assert.equal(names.length, 30); assert.equal(names.includes('z-31.json'), false); assert.equal(names.includes('z-01.json'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('settings changes abort an in-flight review and prevent publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: ({ signal }) => new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true }, 0); await coordinator.run('automatic'); const task = coordinator.running.task;
    for (let index = 0; index < 20 && !coordinator.running; index++) await new Promise(resolve => setTimeout(resolve, 1));
    await coordinator.settings({ provider: 'openai', model: 'replacement', automatic: false }, 1); await task;
    assert.equal((await coordinator.store.latest()), null); assert.equal((await coordinator.store.runtime()).lastJob.error.code, 'SUPERSEDED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup marks an interrupted running job without replaying it immediately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => '{}' });
    await coordinator.store.updateRuntime(runtime => { runtime.lastJob = { id: 'old', state: 'running', startedAt: '2026-09-21T10:00:00Z' }; return runtime; }); coordinator.start();
    for (let index = 0; index < 20 && (await coordinator.store.runtime()).lastJob?.state === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((await coordinator.store.runtime()).lastJob.state, 'interrupted'); coordinator.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed attempt remains visible after restart until a new attempt completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    const before = new Date('2026-09-20T09:00:00Z');
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => before, provider: async () => '{}' });
    // Simulate a failure recorded in an earlier process (no `start()` in this
    // session yet), then a fresh restart that never touched this job.
    await coordinator.store.updateRuntime(runtime => { runtime.lastJob = { id: 'old', state: 'failed', completedAt: before.toISOString(), error: { code: 'PROVIDER_UNAVAILABLE', message: 'Workspace-wide access requires explicit workspace mode' } }; return runtime; });
    const restartedAt = new Date('2026-09-21T09:00:00Z');
    const restarted = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => restartedAt, provider: async () => '{}' });
    restarted.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await restarted.state()).error?.message, 'Workspace-wide access requires explicit workspace mode');
    // A running job interrupted by this restart is also surfaced.
    restarted.stop();
    const interruptedRoot = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-interrupted-'));
    try {
      const stillRunning = new WorkspaceReviewCoordinator({ stateDir: interruptedRoot, workspaceRoot: interruptedRoot, now: () => restartedAt, provider: async () => '{}' });
      await stillRunning.store.updateRuntime(runtime => { runtime.lastJob = { id: 'crashed', state: 'running', startedAt: before.toISOString() }; return runtime; });
      stillRunning.start();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((await stillRunning.state()).error?.code, 'INTERRUPTED');
      stillRunning.stop();
    } finally { await rm(interruptedRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a material change requests an earlier automatic reassessment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async () => '{}' }); await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: false }, 0);
    await coordinator.noteChange(); assert.equal((await coordinator.store.runtime()).pendingRerun, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automatic changes debounce, respect attempt spacing, and retain one retry per evidence fingerprint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    let now = new Date('2026-09-21T10:00:00Z'); let calls = 0;
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => now, provider: async () => { calls++; throw new Error('offline'); } });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true }, 0);
    await coordinator.store.updateRuntime(runtime => { runtime.nextCheckAt = '2026-09-22T10:00:00Z'; return runtime; });
    await coordinator.noteChange(); await coordinator.checkAutomatic(); assert.equal(calls, 0);
    now = new Date(now.getTime() + 60_000); await coordinator.checkAutomatic(); await coordinator.running?.task;
    assert.equal(calls, 2); const runtime = await coordinator.store.runtime(); assert.equal(Object.values(runtime.pipelineRetry).length, 2);
    now = new Date(now.getTime() + 15 * 60_000); await coordinator.checkAutomatic(); assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pausing aborts automatic review and clears queued change scheduling', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\n');
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: ({ signal }) => new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true }, 0); await coordinator.noteChange(); await coordinator.run('automatic'); const task = coordinator.running.task;
    await coordinator.setPaused(true); await task; const runtime = await coordinator.store.runtime();
    assert.equal(runtime.paused, true); assert.equal(runtime.pendingRerun, false); assert.equal(runtime.changeDueAt, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('feedback retains a bounded chronological log and an effective checkpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    const store = new WorkspaceReviewStore({ stateDir: root, workspaceRoot: root });
    for (let index = 0; index < 501; index++) await store.applyControl({ expectedRevision: index, requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, operation: { operation: 'feedback', issueId: `issue-${index}`, evidenceSignature: `evidence-${index}`, action: 'dismiss', until: null, reason: null } });
    const controls = await store.controls(); assert.equal(controls.feedbackLog.length, 500); assert.equal(Object.keys(controls.feedbackCheckpoint).length, 501); assert.equal(Object.keys(controls.issueFeedback).length, 501);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('progress reports return a job and save only a validated copy-only draft', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-'));
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'index.md'), '# Alpha\n'); await writeFile(path.join(root, 'alpha', 'status.md'), '# Status\nCompleted release\n');
    const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async ({ evidence }) => JSON.stringify({ headline: 'Alpha update', completed: [{ text: 'Release completed', evidenceIds: [evidence.projects[0].sources.find(source => source.path === 'status.md').id], claimEvidence: [{ claim: 'complete', sourceId: evidence.projects[0].sources.find(source => source.path === 'status.md').id, excerpt: 'Completed release' }] }], inProgress: [], blockers: [], nextSteps: [], caveats: 'Verify externally.' }) });
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', reportableProjects: ['alpha'] }, 0); const job = await coordinator.runReport('alpha'); assert.equal(job.state, 'running'); await coordinator.reportJobs.get('alpha').task;
    const status = await coordinator.reportStatus('alpha'); assert.equal(status.job.state, 'completed'); assert.equal(status.reports.length, 1); assert.equal(status.reports[0].draft.headline, 'Alpha update');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('report log evidence is limited to the requested dated history', () => {
  const log = '# 2026-08-01\nOld entry\n# 2026-09-20\nCurrent entry\n# 2026-10-01\nFuture entry\n';
  const selected = reportLogHistory(log, '2026-09-01', '2026-09-21'); assert.match(selected, /Current entry/); assert.doesNotMatch(selected, /Old entry|Future entry/);
});

test('review validation rejects vague or multi-action first steps', () => {
  const source = { id: 'source', projectId: 'alpha', path: 'status.md', heading: 'Status', excerpt: '# Status\n', hash: 'hash' }; const raw = { headline: 'Headline', summary: 'Summary', focusProjectId: 'alpha', evidenceIds: ['source'], changes: [], projects: [{ projectId: 'alpha', priority: 'next', rank: 1, priorityReason: 'Reason', confidence: 'medium', trajectory: 'watch', lifecycle: 'active', outcome: 'Outcome', assessment: 'Assessment', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Reason', evidenceIds: ['source'], claimEvidence: [] }], attention: [{ projectId: 'alpha', kind: 'drift', topic: 'Topic', urgency: 'soon', title: 'Title', observation: 'Observed', inference: 'Inferred', action: 'Act', firstStep: 'Review the project', evidenceIds: ['source'], dueDate: null, dueDateEvidence: null, claimEvidence: [] }], question: null };
  assert.throws(() => validateReview(raw, { projects: [{ id: 'alpha' }], sources: [source] }), /firstStep/); raw.attention[0].firstStep = 'Open status.md.'; assert.doesNotThrow(() => validateReview(raw, { projects: [{ id: 'alpha' }], sources: [source] })); raw.attention[0].firstStep = 'Open status.md and write the next test.'; assert.throws(() => validateReview(raw, { projects: [{ id: 'alpha' }], sources: [source] }), /firstStep/);
  const check = step => { raw.attention[0].firstStep = step; return () => validateReview(raw, { projects: [{ id: 'alpha' }], sources: [source] }); };
  // A conjunction inside a heading or title is literal text, not a chain.
  assert.doesNotThrow(check('Open chat-reliability/review.md at Gaps and inconsistencies'));
  assert.doesNotThrow(check('Open review.md at the "Risks and open questions" heading'));
  assert.doesNotThrow(check('Open review.md at the \u201cThen and now\u201d heading'));
  // Genuine chains are still rejected, quoted text or not.
  assert.throws(check('Open review.md at "Gaps" and email Bob'), /firstStep/);
  assert.throws(check('Open review.md, then draft the summary'), /firstStep/);
  assert.throws(check('Open review.md; draft the summary'), /firstStep/);
  assert.throws(check('Open review.md and after that draft the summary'), /firstStep/);
  source.excerpt = '# Status\nDue 2026-02-31.\n'; raw.attention[0].dueDate = '2026-02-31'; raw.attention[0].dueDateEvidence = { sourceId: 'source', excerpt: 'Due 2026-02-31.' };
  assert.throws(() => validateReview(raw, { projects: [{ id: 'alpha' }], sources: [source] }), /real ISO calendar date/);
});
