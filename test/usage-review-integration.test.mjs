import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import review from '../src/workspace-review.js';
import ledger from '../src/usage-store.js';
import capture from '../src/usage-capture.js';

const result = (id, source) => ({ assessment: { projectId: id, confidence: 'medium', trajectory: 'watch', lifecycle: 'active', outcome: 'Ship a release', assessment: 'Work remains active.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [source], claimEvidence: [] }, attentionCandidates: [] });

test('review coordinator attributes project, shared synthesis, correction, cached reuse and progress report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-review-')); const stateDir = await mkdtemp(path.join(tmpdir(), 'usage-review-state-')); const calls = [];
  const store = new ledger.UsageStore({ stateDir, workspaceRoot: root }); await store.init();
  let rejectA = true;
  const coordinator = new review.WorkspaceReviewCoordinator({ stateDir, workspaceRoot: root, usageStore: store, provider: async request => {
    calls.push(request);
    const hook = capture.createUsageCapture({ store, context: { ...request.usageContext, requestedProvider: request.provider, requestedModel: request.model } });
    const observer = await hook({ requestId: `req-${calls.length}`, provider: 'physical', model: request.stage === 'project' ? 'fast' : 'deep', attempt: 1 });
    await observer.onUsage({ usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }, format: 'openai-completions' });
    await observer.onFinish({ status: 'completed' });
    if (!request.stage) return JSON.stringify({ headline: 'Progress', caveats: '', completed: [], inProgress: [], blockers: [], nextSteps: [] });
    if (request.stage === 'project') {
      if (request.projectId === 'A' && rejectA) { rejectA = false; return '{invalid'; }
      return JSON.stringify(result(request.projectId, request.evidence.sources[0].id));
    }
    return JSON.stringify({ headline: 'Review', summary: 'Current project evidence is available.', focusProjectId: null, evidenceIds: [request.evidence.eligibility.evidenceIds[0]], changes: [], priorities: request.evidence.projects.map(p => ({ projectId: p.projectId, priority: 'next', priorityReason: 'Current evidence.' })), attention: [], question: null });
  } });
  try {
    for (const id of ['A', 'B']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), 'Work is active.'); }
    await coordinator.store.saveSettings({ provider: 'github-copilot', model: 'hybrid', automatic: false }, 0);
    const started = await coordinator.run(); await coordinator.running.task;
    let data = await store.snapshot(); const requests = data.requests.filter(r => r.operationId === started.jobId);
    assert.equal(data.operations.find(o => o.operationId === started.jobId).status, 'completed');
    assert.equal(requests.length, 4); assert.equal(requests.filter(r => r.projectId === 'A').length, 2);
    const a = requests.filter(r => r.projectId === 'A'); assert.deepEqual(a.map(r => r.validationOutcome), ['rejected', 'accepted']); assert.equal(a[1].retryOfRequestId, a[0].requestId);
    assert.equal(requests.find(r => r.projectId === 'B').activity, 'project_review');
    const synthesis = requests.find(r => r.activity === 'workspace_review'); assert.equal(synthesis.projectId, null); assert.equal(synthesis.model, 'deep');
    assert.ok(requests.every(r => r.totalTokens === 13 && r.status === 'completed'));
    const cached = await coordinator.run(); await coordinator.running.task;
    data = await store.snapshot(); const cacheOp = data.operations.find(o => o.operationId === cached.jobId);
    assert.deepEqual(cacheOp.reuse.map(x => x.projectId).sort(), ['A', 'B']);
    assert.equal(data.requests.filter(r => r.operationId === cached.jobId && r.activity === 'project_review').length, 0);
    const report = await coordinator.runReport('A'); await coordinator.reportJobs.get('A').task;
    data = await store.snapshot(); const reportRequest = data.requests.find(r => r.operationId === report.jobId);
    assert.equal(reportRequest.projectId, 'A'); assert.equal(reportRequest.activity, 'progress_report'); assert.equal(reportRequest.validationOutcome, 'accepted');
    assert.ok(!JSON.stringify(data).includes('Work is active.'));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); await rm(stateDir, { recursive: true, force: true, maxRetries: 5 }); }
});
