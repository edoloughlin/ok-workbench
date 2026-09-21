import fs from 'node:fs/promises';
import path from 'node:path';

// Six fixture portfolios exercising the judgment rules in
// docs/WORKSPACE-OVERVIEW-SPEC.md ("Detect drift without equating silence
// with failure" and "Escalate without nagging"). Each portfolio writes a
// minimal on-disk project and supplies a fabricated, schema-valid model
// response built from the real collected evidence text, so the fixtures
// never hand-wave source IDs or excerpts the way an ad hoc unit test might.
//
// These are structural/behavioral fixtures intended for CI: they prove the
// collector -> validator -> coordinator -> public-projection pipeline
// handles each named situation the way the spec requires, without spending
// provider credits. They cannot replace the spec's manual semantic review
// step ("inspect whether citations actually support each claim") against
// real model output; that remains a human task performed with a live
// provider, not something a fixture can certify for you.

async function write(root, relative, text) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

function findSource(sources, projectId, matchPath) {
  const source = sources.find(item => item.projectId === projectId && item.path === matchPath);
  if (!source) throw new Error(`fixture expected a collected source at ${matchPath} for ${projectId}`);
  return source;
}

const PORTFOLIOS = [
  {
    slug: 'healthy-but-quiet',
    description: 'A project with a recent, positive recorded outcome and no urgent evidence, despite low recent activity.',
    async build(root) {
      await write(root, 'alpha/index.md', '# Alpha\nShip the v2 export pipeline.\n');
      await write(root, 'alpha/status.md', '# Status\nLast completed: Export pipeline passed integration tests on 2026-08-01.\n');
      await write(root, 'alpha/log.md', '# 2026-08-01\nIntegration tests passed end to end; pipeline verified against production data.\n');
    },
    respond(evidence) {
      const project = evidence.projects.find(item => item.id === 'alpha');
      const status = findSource(evidence.sources, 'alpha', 'status.md');
      return {
        headline: 'Alpha is on course after a verified pipeline pass.',
        summary: 'Alpha has a recorded, verified outcome and no open risk.',
        focusProjectId: project.id, evidenceIds: [status.id], changes: [],
        projects: [{
          projectId: project.id, priority: 'maintain', rank: 1, priorityReason: 'Stable and recently verified.', confidence: 'high',
          trajectory: 'on_course', lifecycle: 'active', outcome: 'Ship the v2 export pipeline.',
          assessment: 'Integration tests passed and were recorded on 2026-08-01.', nextAction: null, blocker: null,
          cadence: 'monthly', cadenceReason: 'No pending deadline or open risk.', evidenceIds: [status.id], claimEvidence: []
        }],
        attention: [], question: null
      };
    },
    expect(assessment) {
      const project = assessment.projects.find(item => item.projectId === 'alpha');
      if (project.trajectory !== 'on_course') throw new Error('expected on_course for a positively evidenced quiet project');
      if (assessment.attention.length) throw new Error('a quiet-but-healthy project must not produce a neglect warning');
    }
  },
  {
    slug: 'busy-but-drifting',
    description: 'Repeated dated deferral of the same milestone without an accepted pause: drift is supported by evidence, not activity volume.',
    async build(root) {
      await write(root, 'beta/index.md', '# Beta\nLaunch the billing migration.\n');
      await write(root, 'beta/status.md', '# Status\nLast completed: Draft migration plan written.\n');
      await write(root, 'beta/log.md', [
        '# 2026-07-01',
        'Deferred the migration cutover again; still waiting on the reconciliation script.',
        '# 2026-07-15',
        'Deferred the migration cutover a second time; reconciliation script still not started.',
        '# 2026-08-01',
        'Deferred the migration cutover a third time; no new work on the reconciliation script.'
      ].join('\n'));
    },
    respond(evidence) {
      const project = evidence.projects.find(item => item.id === 'beta');
      const log = findSource(evidence.sources, 'beta', 'log.md');
      return {
        headline: 'Beta has deferred the same migration cutover three times.',
        summary: 'The billing migration keeps slipping on the same blocking script.',
        focusProjectId: project.id, evidenceIds: [log.id], changes: [],
        projects: [{
          projectId: project.id, priority: 'next', rank: 1, priorityReason: 'Recorded commitment slipping repeatedly.', confidence: 'high',
          trajectory: 'drifting', lifecycle: 'active', outcome: 'Launch the billing migration.',
          assessment: 'The cutover has been deferred three times on the same blocking dependency.', nextAction: 'Start the reconciliation script.', blocker: 'Reconciliation script has not been started.',
          cadence: 'weekly', cadenceReason: 'Recorded slippage warrants a weekly check.', evidenceIds: [log.id], claimEvidence: []
        }],
        attention: [{
          projectId: project.id, kind: 'drift', topic: 'log', urgency: 'soon',
          title: 'Migration cutover deferred three times', observation: 'Three dated log entries defer the same cutover for the same unstarted script.',
          inference: 'Without the reconciliation script, the cutover will keep slipping indefinitely.',
          action: 'Start the reconciliation script this week.', firstStep: 'Draft the reconciliation script outline.',
          evidenceIds: [log.id], dueDate: null, dueDateEvidence: null, claimEvidence: []
        }], question: null
      };
    },
    expect(assessment) {
      const project = assessment.projects.find(item => item.projectId === 'beta');
      if (project.trajectory !== 'drifting') throw new Error('expected drifting when three dated entries defer the same milestone');
      const item = assessment.attention.find(entry => entry.projectId === 'beta');
      if (!item || item.kind !== 'drift') throw new Error('expected a drift attention item with a concrete recovery step');
    }
  },
  {
    slug: 'blocked-before-deadline',
    description: 'A known blocker sits in front of an explicit recorded deadline: at_risk without requiring historical drift.',
    async build(root) {
      await write(root, 'gamma/index.md', '# Gamma\nFile the compliance report.\n');
      await write(root, 'gamma/status.md', '# Status\nDue 2026-09-30. Blocked: waiting on the signed audit letter from Finance.\n');
    },
    respond(evidence) {
      const project = evidence.projects.find(item => item.id === 'gamma');
      const status = findSource(evidence.sources, 'gamma', 'status.md');
      return {
        headline: 'Gamma is blocked ahead of its recorded compliance deadline.',
        summary: 'The compliance report is due 2026-09-30 and is blocked on an external letter.',
        focusProjectId: project.id, evidenceIds: [status.id], changes: [],
        projects: [{
          projectId: project.id, priority: 'focus', rank: 1, priorityReason: 'Recorded deadline with an active blocker.', confidence: 'high',
          trajectory: 'at_risk', lifecycle: 'active', outcome: 'File the compliance report.',
          assessment: 'Blocked on the signed audit letter with the deadline three weeks away.', nextAction: 'Follow up with Finance for the signed letter.', blocker: 'Waiting on the signed audit letter from Finance.',
          cadence: 'daily', cadenceReason: 'Deadline is within the next seven days of daily checks.', evidenceIds: [status.id], claimEvidence: []
        }],
        attention: [{
          projectId: project.id, kind: 'blocker', topic: 'status', urgency: 'soon',
          title: 'Compliance report blocked on an external letter', observation: 'Status records the report is due 2026-09-30 and blocked on Finance.',
          inference: 'Without the letter, the report cannot be filed on time.',
          action: 'Escalate to Finance for the signed letter this week.', firstStep: 'Email Finance to ask for the signed audit letter.',
          evidenceIds: [status.id], dueDate: '2026-09-30', dueDateEvidence: { sourceId: status.id, excerpt: 'Due 2026-09-30' }, claimEvidence: []
        }], question: null
      };
    },
    expect(assessment) {
      const project = assessment.projects.find(item => item.projectId === 'gamma');
      if (project.trajectory !== 'at_risk') throw new Error('expected at_risk for a known blocker ahead of an explicit deadline');
      const item = assessment.attention.find(entry => entry.projectId === 'gamma');
      if (!item || item.dueDate !== '2026-09-30') throw new Error('expected the attention item to carry the recorded due date');
    }
  },
  {
    slug: 'parked',
    description: 'A project the user has explicitly parked until a recorded revisit condition: no neglect nudge before that date.',
    async build(root) {
      await write(root, 'delta/index.md', '# Delta\nExplore the offline-sync spike.\n');
      await write(root, 'delta/status.md', '# Status\nParked until the Q1 planning review; revisit 2027-01-15.\n');
    },
    respond(evidence) {
      const project = evidence.projects.find(item => item.id === 'delta');
      const status = findSource(evidence.sources, 'delta', 'status.md');
      return {
        headline: 'Delta remains parked until the Q1 planning review.',
        summary: 'Delta is deliberately paused with a recorded revisit date.',
        focusProjectId: null, evidenceIds: [status.id], changes: [],
        projects: [{
          projectId: project.id, priority: 'parked', rank: 1, priorityReason: 'Explicitly parked pending planning.', confidence: 'high',
          trajectory: 'unknown', lifecycle: 'parked', outcome: 'Explore the offline-sync spike.',
          assessment: 'Parked until the Q1 planning review on 2027-01-15.', nextAction: null, blocker: null,
          cadence: 'monthly', cadenceReason: 'No action expected before the revisit date.', evidenceIds: [status.id],
          claimEvidence: [{ claim: 'parked', sourceId: status.id, excerpt: 'Parked until the Q1 planning review' }]
        }],
        attention: [], question: null
      };
    },
    expect(assessment) {
      const project = assessment.projects.find(item => item.projectId === 'delta');
      if (project.lifecycle !== 'parked') throw new Error('expected a source-supported parked lifecycle');
      if (assessment.attention.length) throw new Error('a parked project must not receive a neglect warning before its revisit date');
    }
  },
  {
    slug: 'stale-unknown',
    description: 'Status is missing or contradictory: unknown trajectory with an explicit evidence gap, never a fabricated deadline.',
    async build(root) {
      await write(root, 'epsilon/index.md', '# Epsilon\nRebuild the onboarding flow.\n');
      // Deliberately no status.md and no log.md: the collector will record a
      // missing-evidence gap rather than inventing one.
    },
    respond(evidence) {
      const project = evidence.projects.find(item => item.id === 'epsilon');
      const index = findSource(evidence.sources, 'epsilon', 'index.md');
      return {
        headline: 'Epsilon has no recorded status to assess.',
        summary: 'No status or log evidence exists yet for the onboarding rebuild.',
        focusProjectId: null, evidenceIds: [index.id], changes: [],
        projects: [{
          projectId: project.id, priority: 'maintain', rank: 1, priorityReason: 'No evidence to support a stronger priority.', confidence: 'low',
          trajectory: 'unknown', lifecycle: 'active', outcome: 'Rebuild the onboarding flow.',
          assessment: 'No recorded outcome since the project was created; status.md is missing.', nextAction: 'Record current status in status.md.', blocker: null,
          cadence: 'weekly', cadenceReason: 'Unknown cadence defaults to weekly.', evidenceIds: [index.id], claimEvidence: []
        }],
        attention: [{
          projectId: project.id, kind: 'update', topic: 'index', urgency: 'watch',
          title: 'No recorded status for the onboarding rebuild', observation: 'No status.md or log.md exists for this project.',
          inference: 'Without a recorded status, progress toward the outcome cannot be judged.',
          action: 'Add a status.md describing current state.', firstStep: 'Create status.md with one sentence on where this stands.',
          evidenceIds: [index.id], dueDate: null, dueDateEvidence: null, claimEvidence: []
        }], question: null
      };
    },
    expect(assessment) {
      const project = assessment.projects.find(item => item.projectId === 'epsilon');
      if (project.trajectory !== 'unknown') throw new Error('expected unknown trajectory when status/log evidence is missing');
      if (/you have not worked on/i.test(project.assessment)) throw new Error('missing evidence must be phrased as a gap, not as user inactivity');
      const item = assessment.attention.find(entry => entry.projectId === 'epsilon');
      if (!item || item.dueDate) throw new Error('a missing-evidence gap must never carry a fabricated deadline');
    }
  },
  {
    slug: 'competing-priority',
    description: 'A lower-tier project has an imminent explicit deadline while a higher-tier project stays quiet: the task can lead attention without promoting strategic priority.',
    async build(root) {
      await write(root, 'zeta/index.md', '# Zeta\nDeliver the flagship redesign.\n');
      await write(root, 'zeta/status.md', '# Status\nLast completed: Design review approved.\n');
      await write(root, 'eta/index.md', '# Eta\nRenew the vendor contract.\n');
      await write(root, 'eta/status.md', '# Status\nContract renewal due 2026-09-25.\n');
    },
    respond(evidence) {
      const zeta = evidence.projects.find(item => item.id === 'zeta'); const eta = evidence.projects.find(item => item.id === 'eta');
      const zetaStatus = findSource(evidence.sources, 'zeta', 'status.md'); const etaStatus = findSource(evidence.sources, 'eta', 'status.md');
      return {
        headline: 'Zeta stays the strategic focus; Eta has the nearer deadline.',
        summary: 'Eta\u2019s contract renewal is due sooner, but that does not change Zeta\u2019s priority.',
        focusProjectId: zeta.id, evidenceIds: [zetaStatus.id, etaStatus.id], changes: [],
        projects: [
          { projectId: zeta.id, priority: 'focus', rank: 1, priorityReason: 'Flagship outcome with recent approval.', confidence: 'high', trajectory: 'on_course', lifecycle: 'active', outcome: 'Deliver the flagship redesign.', assessment: 'Design review approved; on course.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Steady progress.', evidenceIds: [zetaStatus.id], claimEvidence: [] },
          { projectId: eta.id, priority: 'maintain', rank: 2, priorityReason: 'Routine maintenance task, not strategic.', confidence: 'high', trajectory: 'at_risk', lifecycle: 'active', outcome: 'Renew the vendor contract.', assessment: 'Renewal due 2026-09-25 with no recorded blocker yet.', nextAction: 'Send the renewal paperwork.', blocker: null, cadence: 'daily', cadenceReason: 'Deadline within the next seven days.', evidenceIds: [etaStatus.id], claimEvidence: [] }
        ],
        attention: [{
          projectId: eta.id, kind: 'deadline', topic: 'status', urgency: 'now',
          title: 'Vendor contract renewal due soon', observation: 'Status records the renewal due 2026-09-25.',
          inference: 'Missing the renewal date risks a lapsed vendor contract.',
          action: 'Send the renewal paperwork today.', firstStep: 'Send the renewal document to the vendor.',
          evidenceIds: [etaStatus.id], dueDate: '2026-09-25', dueDateEvidence: { sourceId: etaStatus.id, excerpt: 'Contract renewal due 2026-09-25' }, claimEvidence: []
        }], question: null
      };
    },
    expect(assessment) {
      const zeta = assessment.projects.find(item => item.projectId === 'zeta'); const eta = assessment.projects.find(item => item.projectId === 'eta');
      if (zeta.priority !== 'focus') throw new Error('the urgent task from a lower-tier project must not silently promote or demote strategic priority');
      const item = assessment.attention.find(entry => entry.projectId === 'eta');
      if (!item || item.urgency !== 'now') throw new Error('expected the near-deadline task from the lower-tier project to lead attention urgency');
    }
  }
];

export { PORTFOLIOS };
