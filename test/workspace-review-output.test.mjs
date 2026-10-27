import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import output from '../src/workspace-review-output.js';
import schema from '../src/workspace-review-schema.js';
import review from '../src/workspace-review.js';
import { collectReviewSubmission } from '../src/review-submission.mjs';

const source = { id: 's', projectId: 'A', excerpt: 'Work is active. Due 2026-10-30.', hash: 'hash', path: 'status.md' };
const projectResult = (projectId = 'A', sourceId = 's') => ({ assessment: { projectId, confidence: 'medium', trajectory: 'watch', lifecycle: 'active', outcome: 'Ship a release', assessment: 'Work remains active.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] });
const synthesisResult = projects => ({ headline: 'Review', summary: 'Current project evidence is available.', focusProjectId: null, evidenceIds: [projects[0].sources[0].id], changes: [], priorities: projects.map(item => ({ projectId: item.projectId, priority: 'next', priorityReason: 'Current evidence.' })), attention: [], question: null });
const context = { project: { id: 'A' }, sources: [source] };

test('stale focus and every stale synthesis citation return precise independent issues', () => {
  const sources = [{ ...source }, { ...source, id: 'b', projectId: 'B' }, { id: 'gap', projectId: 'A', generated: true, excerpt: 'Assessment refresh deferred.' }, { id: 'workspace', projectId: null, excerpt: 'Workspace guidance.' }];
  const projects = [{ id: 'A', result: projectResult() }, { id: 'B', result: projectResult('B', 'b') }];
  const context = { projects, sources, currentProjectIds: new Set(['B']) };
  assert.deepEqual(schema.synthesisEligibility(context), { focusProjectIds: ['B'], evidenceIds: ['b', 'gap', 'workspace'] });
  const raw = synthesisResult(projects.map(p => ({ projectId: p.id, sources: sources.filter(s => s.projectId === p.id) })));
  const quote = { sourceId: 's', excerpt: source.excerpt };
  raw.focusProjectId = 'A';
  raw.changes = [{ text: 'Recorded progress.', evidenceIds: ['s'], claimEvidence: [{ claim: 'improvement', ...quote }] }];
  raw.attention = [{ projectId: 'A', kind: 'update', topic: 'Status', urgency: 'soon', title: 'Update status', observation: 'A historical record exists.', inference: 'Current status is unknown.', action: 'Write a status note.', firstStep: 'Write a status note.', evidenceIds: ['s'], dueDate: '2026-10-30', dueDateEvidence: quote, claimEvidence: [] }];
  raw.question = { kind: 'clarification', projectId: 'A', text: 'What is current?', reason: 'Status needs an update.', options: ['Active', 'Not active'], evidenceIds: ['s'] };
  assert.equal(output.inspectOutput('synthesis', raw).accepted, true);
  assert.throws(() => schema.validateStageOutput('synthesis', raw, context), error => {
    assert.equal(error.validationDiagnostic, 'stale_assessment');
    const issues = error.validationFeedback.issues;
    for (const path of ['/focusProjectId', '/evidenceIds/0', '/changes/0/evidenceIds/0', '/changes/0/claimEvidence/0/sourceId', '/attention/0/evidenceIds/0', '/attention/0/dueDateEvidence/sourceId', '/question/evidenceIds/0']) {
      assert.ok(issues.some(issue => issue.path === path && issue.code === (path === '/focusProjectId' ? 'FOCUS_NOT_CURRENT' : 'STALE_EVIDENCE')), path);
    }
    assert.ok(issues.some(issue => issue.rule.includes('eligibility.focusProjectIds')));
    assert.ok(issues.some(issue => issue.rule.includes('eligibility.evidenceIds')));
    assert.equal(output.safeIssues(issues).length, issues.length);
    return true;
  });
  // The canonical validator remains an independent safety boundary.
  assert.throws(() => schema.validateWorkspaceSynthesis(output.canonicalCandidate('synthesis', raw), context), { code: 'INVALID_REVIEW' });
  raw.focusProjectId = null; raw.evidenceIds = ['b']; raw.changes = []; raw.attention = []; raw.question = null;
  raw.priorities[0].priority = 'focus';
  assert.equal(schema.validateStageOutput('synthesis', raw, context).value.projects.find(p => p.projectId === 'A').priority, 'focus');
  raw.focusProjectId = 'B'; assert.doesNotThrow(() => schema.validateStageOutput('synthesis', raw, context));
  raw.evidenceIds = ['s']; assert.throws(() => schema.validateStageOutput('synthesis', raw, context), error => error.validationFeedback.issues.some(issue => issue.code === 'STALE_EVIDENCE'));
  raw.focusProjectId = null; raw.evidenceIds = ['gap'];
  assert.doesNotThrow(() => schema.validateStageOutput('synthesis', raw, { ...context, currentProjectIds: new Set() }));
});

for (const transport of ['json_text', 'result_tool']) test(`${transport}: budget-stale focus override remains usable and precise recovery stays within two synthesis calls`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-review-stale-focus-')); const calls = []; let phase = 'initial';
  const coordinator = new review.WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    calls.push(request);
    if (request.stage === 'project' && phase === 'recover') throw Object.assign(new Error('Synthetic offline provider'), { code: 'PROVIDER_UNAVAILABLE' });
    let candidate;
    if (request.stage === 'project') candidate = projectResult(request.projectId, request.evidence.sources[0].id);
    else {
      const input = request.evidence;
      assert.ok(input.eligibility);
      candidate = synthesisResult(input.projects);
      candidate.evidenceIds = [input.eligibility.evidenceIds[0]];
      if (phase !== 'initial') {
        const stale = input.projects.find(p => p.projectId === 'A');
        assert.equal(stale.state, 'stale'); assert.equal(input.priorityOverrides.A.tier, 'focus');
        assert.deepEqual(input.eligibility.focusProjectIds, ['B']);
        assert.ok(stale.sources.every(s => !input.eligibility.evidenceIds.includes(s.id)));
        if (phase === 'budget') assert.equal(stale.fallbackReason, 'BUDGET');
        candidate.priorities.find(p => p.projectId === 'A').priority = 'focus';
        if (phase === 'recover' && !input.validationFeedback) {
          candidate.focusProjectId = 'A'; candidate.evidenceIds = [stale.sources[0].id];
        }
        if (input.validationFeedback) {
          assert.ok(input.validationFeedback.issues.some(issue => issue.path === '/focusProjectId' && issue.code === 'FOCUS_NOT_CURRENT'));
          assert.ok(input.validationFeedback.issues.some(issue => issue.path === '/evidenceIds/0' && issue.code === 'STALE_EVIDENCE'));
          assert.ok(input.priorCandidate);
        }
      }
    }
    const text = JSON.stringify(candidate);
    return transport === 'json_text' ? text : { version: 1, transport, candidate, finishReason: 'complete', requestCount: 1, responseBytes: Buffer.byteLength(text), outputLimitEnforced: true };
  } });
  try {
    for (const id of ['A', 'B']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), 'Work is active.'); }
    await coordinator.store.saveSettings({ provider: 'github-copilot', model: 'synthetic', automatic: true, dailyAutomaticLimit: 6 }, 0);
    await coordinator.run(); await coordinator.running.task;
    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'focus-A', operation: { operation: 'priority', projectId: 'A', tier: 'focus', reason: 'User preference.' } });
    await writeFile(path.join(root, 'A', 'status.md'), 'Work changed.');
    await coordinator.store.updateRuntime(runtime => { runtime.pipelineAttempts = Array.from({ length: 5 }, () => ({ at: new Date().toISOString(), trigger: 'automatic', stage: 'project', projectId: 'A', status: 'reserved' })); return runtime; });
    phase = 'budget'; calls.length = 0;
    await coordinator.run('automatic'); await coordinator.running.task;
    assert.deepEqual(calls.map(call => call.stage), ['synthesis']);
    assert.equal((await coordinator.store.runtime()).pipelineAttempts.filter(attempt => attempt.trigger === 'automatic').length, 6);
    let state = await coordinator.state();
    assert.equal(state.review.assessment.focusProjectId, null);
    assert.equal(state.review.projects.find(p => p.projectId === 'A').effectivePriority.priority, 'focus');
    assert.equal(state.review.projects.find(p => p.projectId === 'A').assessmentState, 'stale');
    phase = 'recover'; calls.length = 0;
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls.map(call => call.stage), ['project', 'synthesis', 'synthesis']);
    state = await coordinator.state(); assert.equal(state.error, null);
    const latest = await coordinator.store.latest();
    assert.equal(latest.pipeline.output.requestCount, 2);
    assert.equal(latest.pipeline.output.recoveryReason, 'stale_assessment');
    assert.equal(latest.assessment.focusProjectId, null);
    const directory = coordinator.store.traceDirectory();
    const traces = await Promise.all((await readdir(directory, { recursive: true })).filter(name => name.endsWith('.json') && !name.endsWith('owner.json')).map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
    const failed = traces.find(trace => trace.failure.diagnostic === 'stale_assessment');
    assert.ok(failed.failure.issues.some(issue => issue.path === '/focusProjectId' && issue.code === 'FOCUS_NOT_CURRENT'));
    assert.ok(failed.failure.issues.every(issue => Object.keys(issue).sort().join(',') === 'code,path'));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

function narrativeLocations(stage) {
  const locations = [];
  const visit = (node, pointer) => {
    if (node.displayTarget) locations.push([pointer, node]);
    if (node.properties) Object.entries(node.properties).forEach(([key, value]) => visit(value, [...pointer, key]));
    if (node.items) visit(node.items, [...pointer, 0]);
    if (node.anyOf) node.anyOf.filter(item => item.type !== 'null').forEach(item => visit(item, pointer));
  };
  visit(output.stageSchema(stage), []); return locations;
}
function fromSchema(node) {
  if (node.anyOf) return fromSchema(node.anyOf[0]);
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, fromSchema(value)]));
  if (node.type === 'array') return Array.from({ length: Math.max(node.minItems, 1) }, () => fromSchema(node.items));
  if (node.type === 'null') return null;
  return node.enum?.[0] || (node.pattern ? '2026-10-30' : 'Text');
}
for (const stage of ['project', 'synthesis']) {
  test(`${stage} narrative inventory obeys target and Unicode hard boundaries`, () => {
    for (const [pointer, field] of narrativeLocations(stage)) {
      for (const length of [field.displayTarget, field.displayTarget + 1, field.maxLength, field.maxLength + 1]) {
        const raw = fromSchema(output.stageSchema(stage)); let parent = raw;
        for (const part of pointer.slice(0, -1)) parent = parent[part];
        parent[pointer.at(-1)] = '😀'.repeat(length);
        const inspected = output.inspectOutput(stage, raw);
        const location = `/${pointer.join('/')}`;
        assert.equal(inspected.issues.some(item => item.path === location), length > field.maxLength, location);
        assert.equal(inspected.warnings.some(item => item.path === location), length > field.displayTarget, location);
      }
    }
  });
}
test('long narrative preserves text but actions, quotes, and membership stay strict', () => {
  const raw = projectResult(); raw.assessment.assessment = '😀'.repeat(2000);
  const result = schema.validateStageOutput('project', raw, context);
  assert.equal(result.value.assessment.assessment, raw.assessment.assessment);
  assert.equal(result.warnings[0].code, 'DISPLAY_TARGET_EXCEEDED');
  raw.assessment.nextAction = 'x'.repeat(361);
  assert.throws(() => schema.validateStageOutput('project', raw, context), error => error.validationFeedback.issues.some(item => item.path === '/assessment/nextAction'));
  raw.assessment.nextAction = null; raw.assessment.lifecycle = 'complete'; raw.assessment.claimEvidence = [{ claim: 'complete', sourceId: 's', excerpt: 'Invented completion' }];
  assert.throws(() => schema.validateStageOutput('project', raw, context), { code: 'INVALID_REVIEW' });
});
test('ordered priorities derive canonical ranks and reject supplied ranks or missing members', () => {
  const projects = ['B', 'A', 'C'].map(id => ({ id, result: projectResult(id) }));
  const sources = projects.map(item => ({ ...source, id: item.id, projectId: item.id }));
  projects.forEach(item => { item.result.assessment.evidenceIds = [item.id]; });
  const raw = synthesisResult(projects.map(item => ({ projectId: item.id, sources: sources.filter(source => source.projectId === item.id) })));
  const result = schema.validateStageOutput('synthesis', raw, { projects, sources });
  assert.deepEqual(result.value.projects.map(item => [item.projectId, item.rank]), [['B', 1], ['A', 2], ['C', 3]]);
  raw.priorities[0].rank = 8;
  assert.throws(() => schema.validateStageOutput('synthesis', raw, { projects, sources }), { code: 'INVALID_REVIEW' });
  delete raw.priorities[0].rank; raw.priorities[0].projectId = 'A';
  assert.throws(() => schema.validateStageOutput('synthesis', raw, { projects, sources }), { code: 'INVALID_REVIEW' });
});
test('validation collects bounded safe independent issues and survives malformed types', () => {
  const raw = projectResult(); raw.assessment.projectId = 'private unknown project'; raw.assessment.evidenceIds = ['private invented source']; raw.assessment.lifecycle = 'complete';
  assert.throws(() => schema.validateStageOutput('project', raw, context), error => {
    assert.ok(error.validationFeedback.issues.length >= 2);
    assert.ok(!JSON.stringify(error.validationFeedback).includes('private'));
    return true;
  });
  for (const value of [null, [], 'text', { assessment: null, attentionCandidates: [null] }]) assert.throws(() => schema.validateStageOutput('project', value, context), { code: 'INVALID_REVIEW' });
  const bounded = output.feedback(Array.from({ length: 50 }, () => output.issue('/assessment/projectId', 'MEMBERSHIP')));
  assert.equal(bounded.issues.length, 20); assert.equal(bounded.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 8192);
  assert.deepEqual(output.safeIssues([{ path: '/attention/1/evidenceIds/0', code: 'UNKNOWN_EVIDENCE_ID' }]), [{ path: '/attention/1/evidenceIds/0', code: 'UNKNOWN_EVIDENCE_ID' }]);
  assert.deepEqual(output.safeIssues([{ path: '/private-secret', code: 'TYPE' }, { path: '/assessment', code: 'attacker secret' }, { path: '/assessment', code: 'TYPE' }]), [{ path: '/assessment', code: 'TYPE' }]);
});
test('capabilities are exact runtime/endpoint/model records and never inferred from login', () => {
  const selection = { adapter: 'pi', endpoint: 'copilot-chat', model: 'test', runtimeVersion: '1.4.0' };
  const resolver = output.createCapabilityResolver([{ ...selection, source: 'synthetic fixture only' }]);
  assert.equal(resolver.resolve(selection).transport, 'result_tool');
  assert.equal(resolver.resolve({ ...selection, runtimeVersion: 'next' }).resultTool, 'unknown');
  assert.equal(resolver.resolve({ ...selection, model: 'other' }).transport, 'json_text');
  assert.equal(resolver.resolve(selection, 'json_text').transport, 'json_text');
  resolver.markUnsupported(selection);
  assert.equal(resolver.resolve(selection).resultTool, 'unsupported');
});

function fakeRuntime(message, inspect = () => {}, deltas = []) {
  return { streamSimple(model, context, options) {
    inspect(context, options);
    const stream = (async function* () { options.onPayload({}); for (const delta of deltas) yield delta; })();
    stream.result = async () => message; return stream;
  } };
}
const toolCall = (name = 'submit_project_assessment') => ({ type: 'toolCall', name, arguments: projectResult() });
const submit = (content, options = {}) => collectReviewSubmission({ runtime: fakeRuntime({ stopReason: 'toolUse', content, ...options.message }, options.inspect, options.deltas), model: { maxTokens: 3000 }, stage: 'project', prompt: 'Read only', evidence: {}, transport: 'result_tool', maxTokens: 4096, effort: 'high', signal: options.signal });
test('submission declares one non-executable tool and performs no continuation', async () => {
  let requests = 0;
  const result = await submit([{ type: 'text', text: 'Commentary' }, toolCall()], { inspect(context, options) { requests++; assert.equal(context.tools.length, 1); assert.equal(context.tools[0].name, 'submit_project_assessment'); assert.equal(context.tools[0].execute, undefined); assert.equal(options.maxRetries, 0); assert.equal(options.maxTokens, 3000); assert.equal(options.reasoning, 'high'); } });
  assert.equal(requests, 1); assert.equal(result.requestCount, 1); assert.deepEqual(result.candidate, projectResult()); assert.ok(result.responseBytes >= Buffer.byteLength(JSON.stringify(result.candidate)) + 10);
});
test('missing, duplicate, unexpected, truncated, oversized and aborted submissions fail closed', async () => {
  for (const calls of [[], [toolCall(), toolCall()], [toolCall('read_file')]]) await assert.rejects(submit(calls), { code: 'INVALID_REVIEW' });
  await assert.rejects(submit([toolCall()], { message: { stopReason: 'length' } }), { code: 'OUTPUT_TRUNCATED' });
  await assert.rejects(submit([toolCall()], { deltas: [{ type: 'toolcall_delta', delta: 'x'.repeat(17000) }] }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(submit([toolCall()], { signal: AbortSignal.abort() }), { code: 'SUPERSEDED' });
});

test('payload and fetch guards stop hidden retries before another upstream dispatch', async () => {
  for (const extra of ['payload', 'fetch']) {
    let upstream = 0;
    const runtime = { streamSimple(model, context, options) {
      const stream = (async function* () {
        options.onPayload({});
        await options.fetch('http://synthetic.invalid');
        if (extra === 'payload') options.onPayload({});
        else await options.fetch('http://synthetic.invalid');
      })();
      stream.result = async () => ({ stopReason: 'toolUse', content: [toolCall()] });
      return stream;
    } };
    await assert.rejects(collectReviewSubmission({ runtime, model: { maxTokens: 4096 }, stage: 'project', prompt: '', evidence: {}, transport: 'result_tool', fetchImpl: async () => { upstream++; return new Response(''); } }), { code: 'PROVIDER_UNAVAILABLE', outputCategory: 'OUTPUT_REQUEST_COUNT' });
    assert.equal(upstream, 1);
  }
});

test('accepted long project prose preserves storage and fits the synthesis evidence pack', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-review-long-pack-')); let sentPack;
  const coordinator = new review.WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    if (request.stage === 'project') { const candidate = projectResult(request.projectId, request.evidence.sources[0].id); candidate.assessment.assessment = '😀'.repeat(2000); return JSON.stringify(candidate); }
    sentPack = request.evidence.projects[0]; return JSON.stringify(synthesisResult(request.evidence.projects));
  } });
  try {
    await mkdir(path.join(root, 'A')); await writeFile(path.join(root, 'A', 'status.md'), 'Work is active.');
    await coordinator.store.saveSettings({ provider: 'github-copilot', model: 'test' }, 0);
    await coordinator.run(); await coordinator.running.task;
    assert.equal(sentPack.narrativeOmitted, true); assert.ok(Buffer.byteLength(JSON.stringify(sentPack)) <= 8192);
    assert.equal((await coordinator.state()).review.projects[0].assessment, '😀'.repeat(2000));
    assert.equal((await coordinator.store.projectAssessment('A')).result.assessment.assessment, '😀'.repeat(2000));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a full invalid candidate that cannot fit correction is replaced with bounded fresh regeneration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-review-fresh-')); const calls = [];
  const coordinator = new review.WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    calls.push(request);
    if (request.stage === 'project' && calls.length === 1) return 'x'.repeat(12000);
    return JSON.stringify(request.stage === 'project' ? projectResult(request.projectId, request.evidence.sources[0].id) : synthesisResult(request.evidence.projects));
  } });
  const collect = coordinator.collectEvidence;
  coordinator.collectEvidence = async (...args) => ({ ...await collect(...args), workspaceGaps: ['x'.repeat(118000)] });
  try {
    await mkdir(path.join(root, 'A')); await writeFile(path.join(root, 'A', 'status.md'), 'Work is active.');
    await coordinator.store.saveSettings({ provider: 'github-copilot', model: 'test' }, 0);
    await coordinator.run(); await coordinator.running.task;
    assert.equal(calls.length, 3); assert.ok(calls[1].evidence.validationFeedback);
    assert.equal(Object.hasOwn(calls[1].evidence, 'priorCandidate'), false);
    assert.ok((await coordinator.state()).review);
    assert.equal((await coordinator.store.projectAssessment('A')).output.requestCount, 2);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

for (const mode of ['unsupported', 'missing-submission', 'truncated', 'timeout', 'too-large']) {
  test(`${mode} uses only its allowed stage recovery budget`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ok-review-bounds-')); const calls = [];
    const coordinator = new review.WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
      calls.push(request);
      if (request.stage === 'project' && calls.length === 1) throw Object.assign(new Error('private provider error'), { code: mode === 'unsupported' ? 'OUTPUT_TOOL_UNSUPPORTED' : mode === 'missing-submission' ? 'INVALID_REVIEW' : mode === 'truncated' ? 'OUTPUT_TRUNCATED' : mode === 'timeout' ? 'REVIEW_TIMEOUT' : 'RESPONSE_TOO_LARGE', ...(mode === 'missing-submission' ? { outputCategory: 'OUTPUT_SUBMISSION_MISSING' } : {}) });
      return JSON.stringify(request.stage === 'project' ? projectResult(request.projectId, request.evidence.sources[0].id) : synthesisResult(request.evidence.projects));
    } });
    try {
      await mkdir(path.join(root, 'A')); await writeFile(path.join(root, 'A', 'status.md'), 'Work is active.');
      await coordinator.store.saveSettings({ provider: 'github-copilot', model: 'test', automatic: true, dailyAutomaticLimit: 6 }, 0);
      await coordinator.run('automatic'); await coordinator.running.task;
      const recoverable = ['unsupported', 'missing-submission'].includes(mode);
      assert.equal(calls.filter(item => item.stage === 'project').length, recoverable ? 2 : 1);
      if (recoverable) assert.equal(calls[1].forceText, true);
      assert.equal((await coordinator.store.runtime()).pipelineAttempts.length, calls.length);
      assert.ok(!JSON.stringify(await coordinator.state()).includes('private provider error'));
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
  });
}

test('login-only structured envelopes preserve caches and independent assessments after synthesis failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-review-output-')); const calls = []; let failSynthesis = true;
  const coordinator = new review.WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    calls.push(request);
    const candidate = request.stage === 'project' ? projectResult(request.projectId, request.evidence.sources[0].id) : synthesisResult(request.evidence.projects);
    if (request.stage === 'synthesis' && failSynthesis) candidate.priorities[0].rank = 1;
    return { version: 1, transport: 'result_tool', candidate, finishReason: 'complete', requestCount: 1, responseBytes: Buffer.byteLength(JSON.stringify(candidate)), outputLimitEnforced: true };
  } });
  try {
    for (const id of ['A', 'B', 'C']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), 'Work is active.'); }
    await coordinator.store.saveSettings({ provider: 'github-copilot', model: 'synthetic-login-model' }, 0);
    await coordinator.run(); await coordinator.running.task;
    let state = await coordinator.state();
    assert.equal(state.review, null); assert.equal(state.projectAssessments.length, 3); assert.ok(state.projectAssessments.every(item => item.assessmentState === 'current'));
    assert.equal(calls.length, 5); assert.equal((await coordinator.store.runtime()).pipelineAttempts.length, 5);
    assert.ok(calls[4].evidence.validationFeedback.issues.length); assert.equal(calls[4].evidence.priorCandidate.includes('rank'), true);
    calls.length = 0; failSynthesis = false;
    await coordinator.run(); await coordinator.running.task;
    state = await coordinator.state(); assert.equal(state.review.projects.length, 3); assert.deepEqual(calls.map(item => item.stage), ['synthesis']);
    const cache = await coordinator.store.projectAssessment('A'); assert.equal(cache.output.transport, 'result_tool');
    calls.length = 0; await coordinator.run(); await coordinator.running.task; assert.equal(calls.length, 0);
    await coordinator.settings({ provider: 'github-copilot', model: 'synthetic-login-model', excludedProjects: ['A'] }, 1);
    state = await coordinator.state(); assert.ok(!JSON.stringify(state.projectAssessments).includes('"projectId":"A"'));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
