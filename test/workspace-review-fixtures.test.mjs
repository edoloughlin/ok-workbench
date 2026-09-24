import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkspaceReviewCoordinator, collectEvidence } = require('../src/workspace-review.js');
const { validateReview } = require('../src/workspace-review-schema.js');
import { PORTFOLIOS } from './fixtures/workspace-review-portfolios.mjs';

function validProjectResponse(projectId, evidence) {
  const sourceId = evidence.sources.find(source => source.path === 'status.md')?.id || evidence.sources[0].id;
  return JSON.stringify({ assessment: { projectId, confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: `Review ${projectId}`, assessment: 'Current evidence is available.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Review weekly.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] });
}
function validSynthesisResponse(evidence, headline = 'Current workspace review') {
  const projects = evidence.projects; const sourceId = projects[0]?.sources[0]?.id;
  return JSON.stringify({ headline, summary: 'Current project evidence is available.', focusProjectId: null, evidenceIds: sourceId ? [sourceId] : [], changes: [], priorities: projects.map((item, rank) => ({ projectId: item.projectId, priority: 'maintain', rank: rank + 1, priorityReason: 'Review its current evidence.' })), attention: [], question: null });
}

// Fixture-portfolio acceptance tests (spec: "Include fixture portfolios for
// healthy-but-quiet, busy-but-drifting, blocked-before-deadline, parked,
// stale/unknown, and competing-priority situations"). Every portfolio uses a
// deterministic fake provider and an injected clock; no provider credits are
// spent. These check structural/behavioral correctness end to end through
// the real collector, validator, coordinator, and public projection. They do
// not substitute for the spec's manual semantic review of real model output.
for (const portfolio of PORTFOLIOS) {
  test(`fixture portfolio: ${portfolio.slug}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `ok-workbench-review-fixture-${portfolio.slug}-`));
    try {
      await portfolio.build(root);
      const evidence = await collectEvidence(root, { guidance: [] }, new Date('2026-09-08T12:00:00Z'));
      const response = portfolio.respond(evidence);
      // The fixture's fabricated response must itself satisfy the same
      // schema the real model output would be validated against.
      const validated = validateReview(response, { projects: evidence.projects, sources: evidence.sources });
      assert.equal(validated.projects.length, evidence.projects.length);
      const coordinator = new WorkspaceReviewCoordinator({
        stateDir: root, workspaceRoot: root, now: () => new Date('2026-09-08T12:00:00Z'),
        provider: async ({ stage, projectId, evidence: input }) => {
          if (stage === 'project') {
            const item = response.projects.find(project => project.projectId === projectId);
            const { priority, rank, priorityReason, ...assessment } = item;
            return JSON.stringify({ assessment, attentionCandidates: response.attention.filter(item => item.projectId === projectId) });
          }
          return JSON.stringify({ headline: response.headline, summary: response.summary, focusProjectId: response.focusProjectId, evidenceIds: response.evidenceIds, changes: response.changes, priorities: response.projects.map(({ projectId, priority, rank, priorityReason }) => ({ projectId, priority, rank, priorityReason })), attention: response.attention, question: response.question });
        }
      });
      await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
      await coordinator.run(); await coordinator.running.task;
      const state = await coordinator.state();
      assert.ok(state.review, `${portfolio.slug}: expected a completed, published review; ${JSON.stringify(await coordinator.store.runtime())}`);
      // publicReview() overlays effective priority/lifecycle/urgency onto the
      // stored assessment; portfolios check against that public projection,
      // the same shape the overview renders.
      portfolio.expect({ projects: state.review.projects, attention: state.review.attention });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('the fixture set covers all six required portfolio situations', () => {
  const slugs = new Set(PORTFOLIOS.map(item => item.slug));
  for (const required of ['healthy-but-quiet', 'busy-but-drifting', 'blocked-before-deadline', 'parked', 'stale-unknown', 'competing-priority']) {
    assert.ok(slugs.has(required), `missing required fixture portfolio: ${required}`);
  }
});

test('project assessments survive restart, reuse unchanged inputs, and invalidate independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-cache-'));
  const calls = [];
  const provider = async ({ stage, projectId, evidence }) => {
    calls.push({ stage, projectId });
    if (stage === 'project') {
      const sourceId = evidence.sources[0].id;
      return JSON.stringify({ assessment: { projectId, confidence: 'medium', trajectory: 'on_course', lifecycle: 'active', outcome: `Ship ${projectId}`, assessment: 'Work is progressing.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] });
    }
    const ids = evidence.projects.map(item => item.projectId);
    const sourceId = evidence.projects[0].sources[0].id;
    return JSON.stringify({ headline: 'Workspace review', summary: 'Projects are progressing.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: ids.map((id, rank) => ({ projectId: id, priority: 'next', rank: rank + 1, priorityReason: 'Current project.' })), attention: [], question: null });
  };
  const build = () => new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider });
  try {
    for (const id of ['alpha', 'beta', 'gamma']) {
      const directory = path.join(root, id); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'status.md'), `# ${id}\nOriginal state.\n`);
    }
    let coordinator = build(); await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls.map(item => item.stage), ['project', 'project', 'project', 'synthesis']);
    calls.length = 0;

    coordinator = build(); await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [], 'an unchanged review after restart is a complete cache hit');

    await utimes(path.join(root, 'alpha', 'status.md'), new Date('2026-09-09T12:00:00Z'), new Date('2026-09-09T12:00:00Z'));
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [], 'timestamp-only changes do not dirty the bounded source payload');
    await writeFile(path.join(root, 'alpha', 'uncollected-notes.md'), 'This file is outside the selected evidence set.\n');
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [], 'edits to files outside the collector selection do not invalidate caches');

    await writeFile(path.join(root, 'alpha', 'status.md'), '# alpha\nChanged state.\n');
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }]);
    calls.length = 0;

    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'alpha-guidance', operation: { operation: 'guidance', projectId: 'alpha', text: 'Use concise status labels.' } });
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }], 'project-scoped guidance invalidates only its project plus synthesis');
    calls.length = 0;

    await coordinator.store.applyControl({ expectedRevision: 1, requestId: 'global-guidance', operation: { operation: 'guidance', text: 'Use explicit unknowns.' } });
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls.map(item => item.stage), ['project', 'project', 'project', 'synthesis'], 'global guidance invalidates every selected project');
    calls.length = 0;

    await coordinator.store.applyControl({ expectedRevision: 2, requestId: 'priority-only', operation: { operation: 'priority', projectId: 'alpha', tier: 'focus', reason: 'User override.' } });
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'synthesis', projectId: null }], 'priority overrides do not invalidate document assessments');
    calls.length = 0;

    await writeFile(coordinator.store.projectFile('beta'), '{');
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'beta' }, { stage: 'synthesis', projectId: null }], 'one corrupt cache is isolated to its project');
    calls.length = 0;

    await coordinator.run('manual', { force: true }); await coordinator.running.task;
    assert.deepEqual(calls.map(item => item.stage), ['project', 'project', 'project', 'synthesis'], 'explicit force refreshes every selected project');
    calls.length = 0; for (const id of ['alpha', 'beta', 'gamma']) await rm(path.join(root, id), { recursive: true, force: true });
    await coordinator.run(); await coordinator.running.task;
    const empty = await coordinator.state();
    assert.deepEqual(calls, [], 'an empty eligible workspace makes no provider calls');
    assert.deepEqual(empty.review.projects, []); assert.deepEqual(empty.review.attention, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a synthesis-only control change during a project call preserves that valid project cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-flight-'));
  let startProject; let releaseProject;
  const projectStarted = new Promise(resolve => { startProject = resolve; });
  const projectGate = new Promise(resolve => { releaseProject = resolve; });
  const coordinator = new WorkspaceReviewCoordinator({
    stateDir: root, workspaceRoot: root,
    provider: async ({ stage, projectId, evidence }) => {
      if (stage === 'project') {
        startProject(); await projectGate;
        const sourceId = evidence.sources[0].id;
        return JSON.stringify({ assessment: { projectId, confidence: 'medium', trajectory: 'unknown', lifecycle: 'active', outcome: `Review ${projectId}`, assessment: 'Evidence is available.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] });
      }
      const sourceId = evidence.projects[0].sources[0].id;
      return JSON.stringify({ headline: 'Review', summary: 'Current evidence is available.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: evidence.projects.map((item, rank) => ({ projectId: item.projectId, priority: 'next', rank: rank + 1, priorityReason: 'Current evidence.' })), attention: [], question: null });
    }
  });
  try {
    await mkdir(path.join(root, 'alpha'), { recursive: true }); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nCurrent evidence.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); const task = coordinator.running.task; await projectStarted;
    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'priority-during-project', operation: { operation: 'priority', projectId: 'alpha', tier: 'focus', reason: 'User-set priority' } });
    releaseProject(); await task;
    const cached = await coordinator.store.projectAssessment('alpha');
    assert.ok(cached, 'priority changes do not alter project-assessment dependencies');
    assert.equal((await coordinator.store.latest()), null, 'synthesis with the old priority controls cannot publish');
    assert.equal((await coordinator.store.runtime()).lastJob.state, 'superseded');
  } finally { releaseProject(); await rm(root, { recursive: true, force: true }); }
});

test('the 20-project ceiling rotates fairly and discloses omitted rows without old ranks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-25-')); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({
    stateDir: root, workspaceRoot: root, now: () => new Date('2026-09-23T12:00:00Z'),
    provider: async ({ stage, projectId, evidence }) => {
      calls.push({ stage, projectId });
      if (stage === 'project') {
        const sourceId = evidence.sources.find(source => source.path === 'status.md').id;
        return JSON.stringify({ assessment: { projectId, confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: `Unknown ${projectId}`, assessment: 'Evidence requires review.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Review weekly.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] });
      }
      const first = evidence.projects[0]; const sourceId = first.sources[0].id;
      return JSON.stringify({ headline: 'Portfolio review', summary: 'Some projects need review.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: evidence.projects.map((item, rank) => ({ projectId: item.projectId, priority: 'maintain', rank: rank + 1, priorityReason: 'Evidence is limited.' })), attention: [], question: null });
    }
  });
  try {
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    for (let index = 0; index < 25; index++) { const id = `p${String(index).padStart(2, '0')}`; await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), `# ${id}\nEvidence for ${id}.\n`); }
    await coordinator.run(); await coordinator.running.task;
    assert.equal(calls.filter(item => item.stage === 'project').length, 20);
    assert.equal((await coordinator.store.projectAssessments()).length, 20);
    calls.length = 0;
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls.filter(item => item.stage === 'project').map(item => item.projectId).sort(), ['p20', 'p21', 'p22', 'p23', 'p24']);
    const records = await coordinator.store.projectAssessments(); assert.equal(records.length, 25);
    const state = await coordinator.state(); assert.equal(state.review.projects.length, 25);
    const omitted = state.review.projects.filter(item => item.reviewInclusion === 'not_included');
    assert.equal(omitted.length, 5); assert.ok(omitted.every(item => item.assessedAt && item.rank === null));
    assert.deepEqual(state.review.assessment.projects.filter(item => item.rank !== null).map(item => item.rank).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manual calls do not consume the rolling automatic call allowance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-budget-')); let now = new Date('2026-09-23T12:00:00Z'); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date(now), provider: async ({ stage, projectId, evidence, trigger }) => {
    calls.push({ stage, projectId, trigger });
    if (stage === 'project') { const sourceId = evidence.sources[0].id; return JSON.stringify({ assessment: { projectId, confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: 'Review alpha', assessment: 'Evidence is available.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] }); }
    const sourceId = evidence.projects[0].sources[0].id; return JSON.stringify({ headline: 'Review', summary: 'Evidence is available.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: evidence.projects.map((item, rank) => ({ projectId: item.projectId, priority: 'maintain', rank: rank + 1, priorityReason: 'Current evidence.' })), attention: [], question: null });
  } });
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true, dailyAutomaticLimit: 1 }, 0);
    await coordinator.run('manual'); await coordinator.running.task;
    assert.equal(calls.filter(item => item.trigger === 'manual').length, 2);
    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'new-priority-for-automatic', operation: { operation: 'priority', projectId: 'alpha', tier: 'focus', reason: 'A distinct synthesis input.' } });
    await coordinator.store.updateRuntime(runtime => { runtime.nextCheckAt = new Date(now.getTime() - 1).toISOString(); return runtime; });
    now = new Date(now.getTime() + 16 * 60_000); calls.length = 0;
    await coordinator.checkAutomatic(); await coordinator.running?.task;
    assert.deepEqual(calls, [{ stage: 'synthesis', projectId: null, trigger: 'automatic' }]);
    const attempts = (await coordinator.store.runtime()).pipelineAttempts;
    assert.equal(attempts.filter(item => item.trigger === 'automatic').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cadence overrides recompute from the original assessment without refreshing early', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-cadence-')); let now = new Date('2026-09-01T12:00:00Z'); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date(now), provider: async ({ stage, projectId, evidence }) => {
    calls.push({ stage, projectId });
    if (stage === 'project') { const sourceId = evidence.sources[0].id; return JSON.stringify({ assessment: { projectId, confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: 'Review alpha', assessment: 'Evidence needs a steady review.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly evidence review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] }); }
    const sourceId = evidence.projects[0].sources[0].id; return JSON.stringify({ headline: 'Review', summary: 'Evidence is available.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: evidence.projects.map((item, rank) => ({ projectId: item.projectId, priority: 'maintain', rank: rank + 1, priorityReason: 'Evidence is limited.' })), attention: [], question: null });
  } });
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    const original = await coordinator.store.projectAssessment('alpha'); calls.length = 0;
    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'monthly-cadence', operation: { operation: 'cadence', projectId: 'alpha', cadence: 'monthly' } });
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [], 'a cadence change alone does not refresh the assessment or synthesis');
    assert.equal((await coordinator.store.projectAssessment('alpha')).assessedAt, original.assessedAt);
    now = new Date(Date.parse(original.assessedAt) + 29 * 86400000); await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [], 'monthly cadence is measured from the original assessment time');
    now = new Date(Date.parse(original.assessedAt) + 30 * 86400000); await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }]);
    assert.notEqual((await coordinator.store.projectAssessment('alpha')).assessedAt, original.assessedAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deadline refreshes follow the saved timezone and run at most once per local day', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-deadline-')); let now = new Date('2026-09-23T18:30:00Z'); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date(now), provider: async ({ stage, projectId, evidence }) => {
    calls.push({ stage, projectId });
    if (stage === 'project') {
      const sourceId = evidence.sources.find(source => source.path === 'status.md').id;
      return JSON.stringify({ assessment: { projectId, confidence: 'medium', trajectory: 'watch', lifecycle: 'active', outcome: 'Prepare the review.', assessment: 'A documented deadline is approaching.', nextAction: null, blocker: null, cadence: 'monthly', cadenceReason: 'Deadline-aware review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [{ projectId, kind: 'deadline', topic: 'Status', urgency: 'soon', title: 'Review deadline', observation: 'Status records a date.', inference: 'The review needs attention before then.', action: 'Review the checklist.', firstStep: 'Open status.md.', evidenceIds: [sourceId], dueDate: '2026-10-01', dueDateEvidence: { sourceId, excerpt: 'Due 2026-10-01.' }, claimEvidence: [] }] });
    }
    const item = evidence.projects[0]; return JSON.stringify({ headline: 'Review', summary: 'A date is documented.', focusProjectId: null, evidenceIds: [item.sources[0].id], changes: [], priorities: evidence.projects.map((project, rank) => ({ projectId: project.projectId, priority: 'next', rank: rank + 1, priorityReason: 'Review its evidence.' })), attention: [], question: null });
  } });
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nDue 2026-10-01.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', timezone: 'America/Los_Angeles' }, 0);
    await coordinator.run(); await coordinator.running.task;
    assert.equal((await coordinator.store.runtime()).nextCheckAt, '2026-09-24T07:00:00.000Z', 'the seven-day window starts at local midnight');
    calls.length = 0; now = new Date('2026-09-24T07:00:00Z'); await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }]);
    const checked = await coordinator.store.projectAssessment('alpha'); assert.equal(checked.deadlineCheckedDate, '2026-09-24'); assert.equal(checked.result.assessment.cadence, 'monthly'); assert.equal(Date.parse(checked.nextDueAt), Date.parse('2026-10-24T07:00:00.000Z'));
    calls.length = 0; now = new Date('2026-09-24T09:00:00Z'); await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [], 'the same local date does not trigger a second project refresh');
    now = new Date('2026-09-25T07:00:00Z'); await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }], 'crossing local midnight creates one new deadline opportunity');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project and synthesis failures preserve independently successful assessments and the last briefing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-failures-')); const calls = []; let failA = false; let failSynthesis = false;
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async ({ stage, projectId, evidence, attemptNumber }) => {
    calls.push({ stage, projectId, attemptNumber });
    if (stage === 'project') {
      if (failA && projectId === 'a') return '{}';
      const sourceId = evidence.sources.find(source => source.path === 'status.md').id;
      return JSON.stringify({ assessment: { projectId, confidence: 'medium', trajectory: 'unknown', lifecycle: 'unknown', outcome: `Review ${projectId}`, assessment: 'Current evidence is available.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Review weekly.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] });
    }
    if (failSynthesis) return '{}';
    const ids = evidence.projects.map(item => item.projectId); const sourceId = evidence.projects.find(item => item.projectId === 'b').sources[0].id;
    return JSON.stringify({ headline: 'Latest portfolio briefing', summary: 'Current project evidence is available.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: ids.map((id, rank) => ({ projectId: id, priority: 'maintain', rank: rank + 1, priorityReason: 'Review its evidence.' })), attention: [], question: null });
  } });
  try {
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    for (const id of ['a', 'b', 'c']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), `# ${id}\nOriginal evidence.\n`); }
    await coordinator.run(); await coordinator.running.task;
    const original = await coordinator.store.latest(); const originalA = await coordinator.store.projectAssessment('a');

    for (const id of ['a', 'b', 'c']) await writeFile(path.join(root, id, 'status.md'), `# ${id}\nUpdated evidence one.\n`);
    calls.length = 0; failA = true; await coordinator.run(); await coordinator.running.task;
    assert.equal(calls.filter(item => item.stage === 'project' && item.projectId === 'a').length, 2, 'one invalid response gets one bounded correction');
    assert.ok(calls.some(item => item.stage === 'project' && item.projectId === 'b') && calls.some(item => item.stage === 'project' && item.projectId === 'c'));
    const mixed = await coordinator.state();
    assert.equal(mixed.review.projects.find(item => item.projectId === 'a').assessmentState, 'stale');
    assert.equal(mixed.review.projects.find(item => item.projectId === 'a').assessedAt, originalA.assessedAt);
    assert.equal(mixed.review.partial, true); assert.equal(mixed.review.projectErrors.find(item => item.projectId === 'a').validationDiagnostic, 'unsupported_value');

    for (const id of ['a', 'b', 'c']) await writeFile(path.join(root, id, 'status.md'), `# ${id}\nUpdated evidence two.\n`);
    calls.length = 0; failA = false; failSynthesis = true; const beforeSynthesisFailure = await coordinator.store.latest();
    await coordinator.run(); await coordinator.running.task;
    assert.equal((await coordinator.store.latest()).id, beforeSynthesisFailure.id, 'failed synthesis leaves the prior briefing published');
    const refreshedTimes = Object.fromEntries((await coordinator.store.projectAssessments()).map(item => [item.projectId, item.assessedAt]));
    assert.equal(calls.filter(item => item.stage === 'project').length, 3);
    assert.equal((await coordinator.state()).pendingProjectStatus.length, 3, 'new project caches are exposed separately from the saved briefing');

    calls.length = 0; failSynthesis = false; await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls.map(item => item.stage), ['synthesis'], 'retry reuses successful project caches');
    assert.notEqual((await coordinator.store.latest()).id, beforeSynthesisFailure.id);
    assert.deepEqual(Object.fromEntries((await coordinator.store.projectAssessments()).map(item => [item.projectId, item.assessedAt])), refreshedTimes);
    assert.ok(original.id !== (await coordinator.store.latest()).id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automatic fan-out reserves synthesis, honors six rolling calls, and rotates unfinished projects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-six-call-')); let now = new Date('2026-09-23T12:00:00Z'); const calls = []; const dispatches = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date(now), provider: async ({ stage, projectId, evidence, prompt, trigger, attemptNumber, maxTokens }) => {
    calls.push({ stage, projectId, trigger, attemptNumber });
    dispatches.push({ stage, projectId, promptBytes: Buffer.byteLength(prompt), evidenceBytes: Buffer.byteLength(JSON.stringify(evidence)), attemptNumber, maxTokens });
    if (stage === 'project') { const sourceId = evidence.sources[0].id; return JSON.stringify({ assessment: { projectId, confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: `Review ${projectId}`, assessment: 'Current evidence is sparse.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] }); }
    const sourceId = evidence.projects[0].sources[0].id; return JSON.stringify({ headline: 'Partial review', summary: 'Five projects were refreshed within the call allowance.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: evidence.projects.map((item, rank) => ({ projectId: item.projectId, priority: 'maintain', rank: rank + 1, priorityReason: 'Review its evidence.' })), attention: [], question: null });
  } });
  try {
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true, dailyAutomaticLimit: 6 }, 0);
    for (let index = 0; index < 12; index++) { const id = `p${String(index).padStart(2, '0')}`; await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), `# ${id}\nEvidence for ${id}.\n`); }
    await coordinator.run('automatic'); await coordinator.running.task;
    assert.deepEqual(calls.map(item => item.stage), ['project', 'project', 'project', 'project', 'project', 'synthesis']);
    assert.deepEqual(calls.filter(item => item.stage === 'project').map(item => item.projectId).sort(), ['p00', 'p01', 'p02', 'p03', 'p04']);
    assert.deepEqual(dispatches.map(item => item.attemptNumber), [1, 2, 3, 4, 5, 6]);
    assert.ok(dispatches.slice(0, 5).every(item => item.maxTokens === 4096 && item.promptBytes + item.evidenceBytes < 128 * 1024));
    assert.equal(dispatches[5].maxTokens, 16384); assert.ok(dispatches[5].promptBytes + dispatches[5].evidenceBytes < 256 * 1024);
    const firstRuntime = await coordinator.store.runtime(); assert.equal(firstRuntime.pipelineAttempts.filter(item => item.trigger === 'automatic').length, 6);
    assert.equal((await coordinator.store.latest()).partial, true);
    assert.equal(firstRuntime.nextCheckAt, new Date(now.getTime() + 86400000 + 1).toISOString(), 'the next automatic slot opens when a rolling call reservation expires');

    now = new Date(now.getTime() + 86400000 + 60_000); calls.length = 0; dispatches.length = 0;
    await coordinator.checkAutomatic(); await coordinator.running?.task;
    assert.deepEqual(calls.filter(item => item.stage === 'project').map(item => item.projectId).sort(), ['p05', 'p06', 'p07', 'p08', 'p09']);
    assert.equal(calls.filter(item => item.stage === 'synthesis').length, 1);
    assert.equal((await coordinator.store.projectAssessments()).length, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('priority expiry and snooze expiry are projected immediately and scheduled without project calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-expiry-')); let now = new Date('2026-09-23T12:00:00Z'); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date(now), provider: async ({ stage, projectId, evidence, trigger }) => {
    calls.push({ stage, projectId, trigger });
    if (stage === 'project') { const sourceId = evidence.sources[0].id; return JSON.stringify({ assessment: { projectId, confidence: 'medium', trajectory: 'unknown', lifecycle: 'active', outcome: 'Complete the draft.', assessment: 'Current evidence names a draft.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] }); }
    const sourceId = evidence.projects[0].sources[0].id; return JSON.stringify({ headline: 'Review', summary: 'A documented draft remains.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: evidence.projects.map((item, rank) => ({ projectId: item.projectId, priority: 'next', rank: rank + 1, priorityReason: 'The draft needs attention.' })), attention: [{ projectId: 'alpha', kind: 'update', topic: 'Status', urgency: 'soon', title: 'Update the draft', observation: 'Status names a draft.', inference: 'A short update would clarify its state.', action: 'Record the draft status.', firstStep: 'Open status.md.', evidenceIds: [sourceId], dueDate: null, dueDateEvidence: null, claimEvidence: [] }], question: null });
  } });
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nDraft remains in progress.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true }, 1);
    const issue = (await coordinator.store.latest()).assessment.attention[0]; const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'priority-expiry', operation: { operation: 'priority', projectId: 'alpha', tier: 'focus', reason: 'Temporary focus.', expiresAt } });
    calls.length = 0; await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls.map(item => item.stage), ['synthesis']);
    assert.equal((await coordinator.state()).review.projects[0].effectivePriority.priority, 'focus');
    await coordinator.store.applyControl({ expectedRevision: 1, requestId: 'snooze-expiry', operation: { operation: 'feedback', issueId: issue.id, evidenceSignature: issue.evidenceSignature, action: 'snooze', until: expiresAt, reason: null } });
    calls.length = 0; await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls.map(item => item.stage), ['synthesis']);
    const snoozed = await coordinator.state(); assert.equal(snoozed.review.attention.length, 0); assert.equal(snoozed.review.deferred.length, 1);
    assert.equal((await coordinator.store.runtime()).nextCheckAt, expiresAt);
    now = new Date(expiresAt); const beforeGet = calls.length; const projected = await coordinator.state();
    assert.equal(projected.review.attention.length, 1); assert.equal(calls.length, beforeGet, 'GET applies expiry without dispatching a provider call');
    calls.length = 0; await coordinator.checkAutomatic(); await coordinator.running?.task;
    assert.deepEqual(calls, [{ stage: 'synthesis', projectId: null, trigger: 'automatic' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rolling reservations permit one automatic project call across restart and preserve the synthesis slot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-reservation-restart-')); const calls = [];
  const provider = async request => { calls.push({ stage: request.stage, projectId: request.projectId }); return request.stage === 'project' ? validProjectResponse(request.projectId, request.evidence) : validSynthesisResponse(request.evidence); };
  const make = () => new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date('2026-09-23T12:00:00Z'), provider });
  try {
    for (const id of ['alpha', 'beta']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), `# ${id}\nEvidence.\n`); }
    let coordinator = make(); await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true, dailyAutomaticLimit: 2 }, 0);
    await coordinator.run('automatic'); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }]);
    const reserved = await coordinator.store.runtime();
    assert.deepEqual(reserved.pipelineAttempts.map(item => item.stage), ['project', 'synthesis']);
    assert.ok(reserved.pipelineAttempts.every(item => item.status === 'reserved'), 'attempt reservations remain durable after dispatch');
    await coordinator.store.updateRuntime(runtime => {
      runtime.pipelineAttempts.push(...Array.from({ length: 600 }, (_, index) => ({ at: new Date(Date.parse('2026-09-23T12:00:00Z') + index + 1).toISOString(), trigger: 'manual', stage: 'project', projectId: 'manual', status: 'reserved' })));
      return runtime;
    });
    calls.length = 0; coordinator = make();
    await coordinator.run('automatic'); await coordinator.running.task;
    assert.deepEqual(calls, [], 'manual reservation volume and restart cannot release prior automatic reservations');
    assert.equal((await coordinator.store.runtime()).pipelineAttempts.filter(item => item.trigger === 'automatic').length, 2);
    assert.ok((await coordinator.state()).review.partial, 'the unfinished project remains disclosed after restart');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent automatic coordinators cannot reserve the same final project slot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-concurrent-reservation-')); const calls = []; let release; let begin;
  const started = new Promise(resolve => { begin = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const provider = async request => {
    calls.push({ stage: request.stage, projectId: request.projectId });
    if (request.stage === 'project' && calls.filter(item => item.stage === 'project').length === 1) { begin(); await gate; }
    return request.stage === 'project' ? validProjectResponse(request.projectId, request.evidence) : validSynthesisResponse(request.evidence);
  };
  const make = () => new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date('2026-09-23T12:00:00Z'), provider });
  try {
    for (const id of ['alpha', 'beta']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), `# ${id}\nEvidence.\n`); }
    const first = make(); await first.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true, dailyAutomaticLimit: 2 }, 0);
    const second = make();
    await Promise.all([first.run('automatic'), second.run('automatic')]);
    const firstTask = first.running?.task; const secondTask = second.running?.task;
    await started;
    assert.equal(calls.filter(item => item.stage === 'project').length, 1, 'only one worker can reserve a project attempt');
    release(); await Promise.all([firstTask, secondTask]);
    assert.equal(calls.filter(item => item.stage === 'project').length, 1);
    assert.equal(calls.filter(item => item.stage === 'synthesis').length, 1, 'the reserved synthesis slot remains available exactly once');
    assert.equal((await first.store.runtime()).pipelineAttempts.filter(item => item.trigger === 'automatic').length, 2);
    const restarted = make(); await restarted.run('automatic'); await restarted.running?.task;
    assert.equal(calls.length, 2, 'restart cannot replay a reserved call');
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('one remaining automatic attempt runs synthesis with fallbacks and no project dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-one-call-')); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    calls.push({ stage: request.stage, projectId: request.projectId });
    if (request.stage === 'project') return validProjectResponse(request.projectId, request.evidence);
    const sourceId = request.evidence.workspace[0].id;
    return JSON.stringify({ headline: 'Insufficient current project evidence', summary: 'No project assessment could be refreshed within the remaining call budget.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: request.evidence.projects.map((item, rank) => ({ projectId: item.projectId, priority: 'maintain', rank: rank + 1, priorityReason: 'Current evidence is unavailable.' })), attention: [], question: null });
  } });
  try {
    await writeFile(path.join(root, 'index.md'), '# Workspace context\n');
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', automatic: true, dailyAutomaticLimit: 1 }, 0);
    await coordinator.run('automatic'); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'synthesis', projectId: null }]);
    assert.equal(await coordinator.store.projectAssessment('alpha'), null);
    const state = await coordinator.state(); assert.ok(state.review); assert.equal(state.review.partial, true);
    assert.equal(state.review.projects[0].assessmentState, 'unavailable'); assert.equal(state.review.projects[0].refreshReason, 'BUDGET');
    assert.equal((await coordinator.store.runtime()).pipelineAttempts.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cold-start synthesis failure exposes successful project progress but no completed briefing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-cold-synthesis-failure-')); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    calls.push({ stage: request.stage, projectId: request.projectId });
    return request.stage === 'project' ? validProjectResponse(request.projectId, request.evidence) : '{}';
  } });
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }, { stage: 'synthesis', projectId: null }]);
    assert.ok(await coordinator.store.projectAssessment('alpha'));
    assert.equal(await coordinator.store.latest(), null, 'the first invalid synthesis never creates a completed briefing');
    const state = await coordinator.state(); assert.equal(state.review, null);
    assert.deepEqual(state.pendingProjectStatus.map(item => [item.projectId, item.state]), [['alpha', 'current']]);
    assert.equal(state.error.code, 'INVALID_REVIEW');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('allocation and effective feedback changes invalidate synthesis only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-effective-controls-')); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, now: () => new Date('2026-09-23T12:00:00Z'), provider: async request => {
    calls.push({ stage: request.stage, projectId: request.projectId });
    if (request.stage === 'project') {
      const sourceId = request.evidence.sources.find(source => source.path === 'status.md').id;
      const deadline = request.projectId === 'beta';
      return JSON.stringify({ assessment: { projectId: request.projectId, confidence: 'medium', trajectory: 'unknown', lifecycle: 'active', outcome: `Review ${request.projectId}`, assessment: 'Current evidence is available.', nextAction: null, blocker: null, cadence: 'monthly', cadenceReason: 'Monthly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: deadline ? [{ projectId: request.projectId, kind: 'deadline', topic: 'Status', urgency: 'soon', title: 'Prepare for the due date', observation: 'The status records a date.', inference: 'A review before the date would help.', action: 'Review the checklist.', firstStep: 'Open status.md.', evidenceIds: [sourceId], dueDate: '2026-09-30', dueDateEvidence: { sourceId, excerpt: 'Due 2026-09-30.' }, claimEvidence: [] }] : [] });
    }
    const projects = request.evidence.projects; const beta = projects.find(item => item.projectId === 'beta'); const source = beta?.sources.find(item => item.path === 'status.md');
    return JSON.stringify({ headline: 'Portfolio review', summary: 'Current evidence is available.', focusProjectId: null, evidenceIds: source ? [source.id] : [], changes: [], priorities: projects.map((item, rank) => ({ projectId: item.projectId, priority: item.projectId === 'beta' ? 'next' : 'maintain', rank: rank + 1, priorityReason: 'Review current evidence.' })), attention: source ? [{ projectId: 'beta', kind: 'deadline', topic: 'Status', urgency: 'soon', title: 'Prepare for the due date', observation: 'The status records a date.', inference: 'A review before the date would help.', action: 'Review the checklist.', firstStep: 'Open status.md.', evidenceIds: [source.id], dueDate: '2026-09-30', dueDateEvidence: { sourceId: source.id, excerpt: 'Due 2026-09-30.' }, claimEvidence: [] }] : [], question: null });
  } });
  try {
    for (const id of ['alpha', 'beta']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), id === 'beta' ? '# Beta\nDue 2026-09-30.\n' : '# Alpha\nCurrent evidence.\n'); }
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer', activityTracking: true }, 0);
    await coordinator.run(); await coordinator.running.task;
    for (let index = 0; index < 8; index++) await coordinator.recordActivity('alpha', 'chat');
    calls.length = 0; await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'synthesis', projectId: null }], 'a newly effective allocation fact changes synthesis but not document assessments');
    const issue = (await coordinator.store.latest()).assessment.attention[0];
    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'feedback-suppresses-deadline', operation: { operation: 'feedback', issueId: issue.id, evidenceSignature: issue.evidenceSignature, action: 'dismiss', reason: 'No longer relevant.' } });
    calls.length = 0; await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, [{ stage: 'synthesis', projectId: null }], 'effective feedback changes synthesis only');
    assert.equal((await coordinator.state()).review.attention.length, 0, 'feedback suppression is projected immediately');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a project whose evidence changes in flight cannot commit, while unrelated project caches survive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-project-superseded-')); let begin; let release;
  const started = new Promise(resolve => { begin = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    if (request.stage === 'project' && request.projectId === 'alpha') { begin(); await gate; }
    return request.stage === 'project' ? validProjectResponse(request.projectId, request.evidence) : validSynthesisResponse(request.evidence);
  } });
  try {
    for (const id of ['alpha', 'beta']) { await mkdir(path.join(root, id)); await writeFile(path.join(root, id, 'status.md'), `# ${id}\nOriginal.\n`); }
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); const task = coordinator.running.task; await started;
    await writeFile(path.join(root, 'alpha', 'status.md'), '# alpha\nChanged while the request was running.\n');
    release(); await task;
    assert.equal(await coordinator.store.projectAssessment('alpha'), null, 'obsolete project response is not cached');
    assert.ok(await coordinator.store.projectAssessment('beta'), 'unrelated valid result commits independently');
    assert.equal(await coordinator.store.latest(), null, 'a superseded project snapshot cannot publish synthesis');
    assert.equal((await coordinator.store.runtime()).pendingRerun, true);
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('excluding a project while synthesis is in flight prevents publication and redacts the prior review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-excluded-flight-')); let begin; let release; let blockSynthesis = false;
  const started = new Promise(resolve => { begin = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => {
    if (request.stage === 'synthesis' && blockSynthesis) { begin(); await gate; }
    return request.stage === 'project' ? validProjectResponse(request.projectId, request.evidence) : validSynthesisResponse(request.evidence, 'Sensitive alpha briefing');
  } });
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nSensitive evidence must be redacted.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task; const prior = await coordinator.store.latest();
    await coordinator.store.applyControl({ expectedRevision: 0, requestId: 'change-synthesis', operation: { operation: 'priority', projectId: 'alpha', tier: 'focus', reason: 'Change synthesis input.' } });
    blockSynthesis = true; await coordinator.run(); const task = coordinator.running.task; await started;
    await coordinator.settings({ provider: 'openai', model: 'reviewer', excludedProjects: ['alpha'] }, 1);
    release(); await task;
    assert.equal((await coordinator.store.latest()).id, prior.id, 'old briefing stays published');
    const state = await coordinator.state();
    assert.deepEqual(state.review.projects, []); assert.equal(state.review.assessment.focusProjectId, null);
    assert.ok(!JSON.stringify(state.review).includes('Sensitive alpha briefing'));
    assert.ok(!JSON.stringify(state.review).includes('Sensitive evidence must be redacted'));
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('provider, model, and effort changes invalidate project caches; legacy latest never seeds them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-config-')); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => { calls.push({ stage: request.stage, projectId: request.projectId }); return request.stage === 'project' ? validProjectResponse(request.projectId, request.evidence) : validSynthesisResponse(request.evidence); } });
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'first', effort: 'low' }, 0);
    const legacy = { schemaVersion: 1, id: 'legacy-review', completedAt: '2026-09-01T00:00:00Z', inputFingerprint: 'legacy', assessment: { headline: 'Legacy briefing', summary: 'For display only.', focusProjectId: null, evidenceIds: [], changes: [], projects: [], attention: [], question: null }, coverage: [], sources: [] };
    await coordinator.store.saveReview(legacy);
    assert.equal((await coordinator.store.latest()).id, 'legacy-review'); assert.equal((await coordinator.store.projectAssessments()).length, 0);
    for (const settings of [{ provider: 'anthropic', model: 'first', effort: 'low' }, { provider: 'anthropic', model: 'second', effort: 'low' }, { provider: 'anthropic', model: 'second', effort: 'high' }]) {
      calls.length = 0; const currentSettings = await coordinator.store.settings(); await coordinator.store.saveSettings(settings, currentSettings.revision); await coordinator.run(); await coordinator.running.task;
      assert.deepEqual(calls, [{ stage: 'project', projectId: 'alpha' }, { stage: 'synthesis', projectId: null }], 'each model/provider/effort key change refreshes assessment and synthesis');
    }
    const cache = await coordinator.store.projectAssessment('alpha'); assert.equal(cache.provider, 'anthropic'); assert.equal(cache.model, 'second'); assert.equal(cache.effort, 'high');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('synthesis-only version changes reuse project cache while project-stage versions invalidate it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ok-workbench-review-version-split-')); const calls = [];
  const coordinator = new WorkspaceReviewCoordinator({ stateDir: root, workspaceRoot: root, provider: async request => { calls.push(request.stage); return request.stage === 'project' ? validProjectResponse(request.projectId, request.evidence) : validSynthesisResponse(request.evidence); } });
  coordinator.pipelineVersions = { collector: 2, projectPrompt: 2, validator: 2, synthesisPrompt: 1 };
  try {
    await mkdir(path.join(root, 'alpha')); await writeFile(path.join(root, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
    await coordinator.run(); await coordinator.running.task;
    const first = await coordinator.store.projectAssessment('alpha');
    calls.length = 0; coordinator.pipelineVersions.synthesisPrompt = 2;
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, ['synthesis'], 'synthesis prompt changes do not dirty per-project cache keys');
    assert.equal((await coordinator.store.projectAssessment('alpha')).inputKey, first.inputKey);
    calls.length = 0; coordinator.pipelineVersions.validator = 3;
    await coordinator.run(); await coordinator.running.task;
    assert.deepEqual(calls, ['project', 'synthesis'], 'project validator changes invalidate project cache compatibility');
  } finally { await rm(root, { recursive: true, force: true }); }
});
