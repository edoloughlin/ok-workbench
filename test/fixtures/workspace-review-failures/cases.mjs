// Fictional reconstructions of observed failures, not redacted raw exchanges.
// No original project names, prose, source hashes, dates, or trace IDs are kept.
const clone = value => structuredClone(value);
const source = (projectId, text) => ({
  id: `${projectId}-status`, projectId, path: 'status.md', heading: 'Status',
  excerpt: text, hash: `${projectId}-fixture`, generated: false, truncated: false
});
const assessment = (projectId, sourceId, overrides = {}) => ({
  projectId, confidence: 'medium', trajectory: 'watch', lifecycle: 'active',
  outcome: 'Validate the delivery kit.', assessment: 'The M1 validation is still pending.',
  nextAction: 'Run the M1 validation.', blocker: null, cadence: 'weekly',
  cadenceReason: 'Review until validation is complete.', evidenceIds: [sourceId], claimEvidence: [], ...overrides
});
const attention = (projectId, sourceId, overrides = {}) => ({
  projectId, kind: 'decision', topic: 'Validation', urgency: 'soon',
  title: 'Complete the M1 validation', observation: 'The M1 validation is pending.',
  inference: 'The kit cannot be accepted until validation succeeds.',
  action: 'Run M1 and record its outcome in review.md.', firstStep: 'Run the M1 validation.',
  evidenceIds: [sourceId], dueDate: null, dueDateEvidence: null, claimEvidence: [], ...overrides
});
function projectInput(text) {
  const projectId = 'delivery-kit';
  return {
    projectId, sources: [source(projectId, text)], missing: [], workspace: [], workspaceGaps: [],
    guidance: [], reviewDate: '2031-04-10', timezone: 'UTC'
  };
}
const validationText = '# Status\nOutcome: Validate the delivery kit.\nM1 validation is pending. Acceptance requires a passing M1 result. Record the result in review.md.\n';
const projectEvidence = projectInput(validationText);
const projectReference = {
  assessment: assessment('delivery-kit', 'delivery-kit-status'),
  attentionCandidates: [attention('delivery-kit', 'delivery-kit-status')]
};
function synthesisInput() {
  const records = [
    ['archive-catalog', 'stale', '# Status\nCatalog launch due 2031-04-11. Supplier confirmation is pending.\n'],
    ['delivery-kit', 'current', validationText],
    ['guide-refresh', 'current', '# Status\nThe guide draft passed its editorial review. No open blocker.\n'],
    ['sensor-trial', 'current', '# Status\nTrial is proceeding against its agreed milestones.\n'],
    ['handover-plan', 'current', '# Status\nThe handover rehearsal is complete. No open blocker.\n'],
    ['service-check', 'current', '# Status\nThe service check passed. No pending follow-up.\n']
  ];
  return {
    projects: records.map(([projectId, state, text], index) => {
      const evidence = source(projectId, text);
      return {
        projectId, state, assessedAt: state === 'current' ? '2031-04-10T12:00:00Z' : '2031-04-01T12:00:00Z',
        fallbackReason: state === 'stale' ? 'PROVIDER_UNAVAILABLE' : null, gaps: [],
        assessment: assessment(projectId, evidence.id, index === 1 ? {} : {
          outcome: `Deliver ${projectId}.`, assessment: state === 'stale' ? 'Supplier confirmation was pending at the last assessment.' : 'The recorded milestone passed.',
          nextAction: state === 'stale' ? 'Request supplier confirmation.' : null, trajectory: state === 'stale' ? 'at_risk' : 'on_course'
        }),
        attentionCandidates: index === 1 ? clone(projectReference.attentionCandidates) : [],
        sources: [{ id: evidence.id, projectId, path: evidence.path, heading: evidence.heading, text, generated: false }]
      };
    }),
    workspace: [], workspaceGaps: [], guidance: [], priorityOverrides: {}, suppression: [],
    recurrence: [], allocation: null, deadlineToken: '2031-04-10', timezone: 'UTC', comparison: null
  };
}
const synthesisEvidence = synthesisInput();
const synthesisReference = {
  headline: 'Validate the delivery kit.', summary: 'M1 is pending. The archive catalog assessment is stale and needs a refresh before acting on its old deadline.',
  focusProjectId: 'delivery-kit', evidenceIds: ['delivery-kit-status'], changes: [],
  priorities: synthesisEvidence.projects.map((project, index) => ({
    projectId: project.projectId, priority: index === 1 ? 'focus' : 'maintain',
    priorityReason: index === 0 ? 'Stale context; obtain a current assessment.' : index === 1 ? 'The current source records pending validation.' : 'No open blocker in current evidence.'
  })),
  attention: clone(projectReference.attentionCandidates), question: null
};
const staleFocus = clone(synthesisReference);
staleFocus.focusProjectId = 'archive-catalog';
staleFocus.headline = 'Confirm the archive catalog launch.';
staleFocus.summary = 'Supplier confirmation is pending before the catalog deadline.';
staleFocus.evidenceIds = ['archive-catalog-status'];
staleFocus.priorities[0].priority = 'focus';
staleFocus.priorities[1].priority = 'next';
const staleCorrection = clone(staleFocus);
staleCorrection.focusProjectId = null;
staleCorrection.attention = [attention('archive-catalog', 'archive-catalog-status', {
  kind: 'deadline', title: 'Obtain supplier confirmation', topic: 'Supplier', urgency: 'now',
  observation: 'The cached status records a catalog deadline.', inference: 'Supplier confirmation is needed before launch.',
  action: 'Request supplier confirmation.', firstStep: 'Draft the supplier confirmation request.',
  dueDate: '2031-04-11', dueDateEvidence: { sourceId: 'archive-catalog-status', excerpt: 'Catalog launch due 2031-04-11.' }
})];
const chainedStep = clone(projectReference);
chainedStep.attentionCandidates[0].firstStep = 'Run M1 and record its outcome in review.md.';
const longOutcome = clone(projectReference);
// Preserve the observed length (244). It now exceeds a display target, not a hard limit.
longOutcome.assessment.outcome = ('Validate the delivery kit against the acceptance checklist, document repeatable results, resolve outstanding compatibility questions, record the final configuration, and provide a concise handover guide for the trial team. Additional requirements.').slice(0, 244);
const malformed = JSON.stringify(projectReference).replace(/\[\]\}\]\}$/, '[]}}]}');
const recoveredTail = `${JSON.stringify(projectReference)}}`;
const provenance = (observations, diagnostic, disposition = 'rejected') => ({
  kind: 'anonymised-reconstruction', observations, diagnostic, disposition
});
const criteria = {
  project: {
    requiredAttentionProjectIds: ['delivery-kit'], maxOutcomeLength: 200,
    manual: ['Citations support the pending validation.', 'The first step performs M1; recording the outcome belongs in action.', 'Do not invent completion, owners, or deadlines.']
  },
  synthesis: {
    requiredAttentionProjectIds: ['delivery-kit'],
    manual: ['Keep all six projects ranked, including stale context.', 'Recommend a current evidenced action, rather than the stale but urgent-looking launch.', 'Mention stale context without converting it into a new deadline claim.']
  }
};
export const FAILURE_CASES = [
  {
    id: 'stale-project-selected-as-focus', stage: 'synthesis',
    provenance: provenance(2, 'schema_mismatch'),
    description: 'An urgent-looking cached project attracts focus despite its stale state; the input still includes five current projects.',
    promptTarget: 'Make eligibility for focus and the current project IDs explicit before ranking urgency.',
    input: synthesisEvidence, failedResponse: JSON.stringify(staleFocus), referenceResponse: JSON.stringify(synthesisReference),
    expectedFailure: { issueCode: 'FOCUS_NOT_CURRENT' }, criteria: criteria.synthesis
  },
  {
    id: 'correction-retains-stale-citations', stage: 'synthesis',
    provenance: provenance(2, 'evidence_reference'),
    description: 'A correction removes the stale focus but retains stale citations and a stale deadline in substantive output.',
    promptTarget: 'Recheck every output citation after a focus correction; changing only focusProjectId does not repair the review.',
    input: { ...clone(synthesisEvidence), priorCandidate: JSON.stringify(staleFocus), validationFeedback: 'focus must use a current project assessment' },
    failedResponse: JSON.stringify(staleCorrection), referenceResponse: JSON.stringify(synthesisReference),
    expectedFailure: { issueCode: 'STALE_EVIDENCE' }, criteria: criteria.synthesis
  },
  {
    id: 'first-step-chains-execution-and-recording', stage: 'project',
    provenance: provenance(1, 'first_step'),
    description: 'A useful recommendation fails because the first step includes running a check and recording the result.',
    promptTarget: 'Keep one visible action in firstStep and follow-up work in action.',
    input: projectEvidence, failedResponse: JSON.stringify(chainedStep), referenceResponse: JSON.stringify(projectReference),
    expectedFailure: { issueCode: 'ACTION' }, criteria: criteria.project
  },
  {
    id: 'outcome-exceeds-field-budget', stage: 'project',
    provenance: provenance(1, 'unsupported_value'),
    description: 'A 244-character outcome exceeds the display target. Accept it as valid production output while grading concision separately.',
    promptTarget: 'Summarise the desired outcome within the 200-character target instead of copying its full requirements.',
    input: projectInput(`# Status\nOutcome: ${longOutcome.assessment.outcome}\nM1 validation is pending. Record the result in review.md.\n`),
    failedResponse: JSON.stringify(longOutcome), referenceResponse: JSON.stringify(projectReference),
    expectedFailure: { presentationOnly: true }, criteria: criteria.project
  },
  {
    id: 'malformed-nested-array-closure', stage: 'project',
    provenance: provenance(1, 'invalid_json_missing_separator'),
    description: 'The response closes an object while still inside the attention array; removing a trailing brace cannot repair the internal structure.',
    promptTarget: 'Close nested arrays and objects correctly; return exactly one complete JSON object.',
    input: projectEvidence, failedResponse: malformed, referenceResponse: JSON.stringify(projectReference),
    expectedFailure: { parseError: true }, criteria: criteria.project
  },
  {
    id: 'extra-closing-brace-after-complete-json', stage: 'project',
    provenance: provenance(2, 'invalid_json_extra_closing_brace', 'recovered'),
    description: 'A complete valid object has an extra closing brace. Production recovers it, but the prompt evaluation must report invalid raw JSON.',
    promptTarget: 'Stop immediately after the final object brace; avoid relying on delimiter recovery.',
    input: projectEvidence, failedResponse: recoveredTail, referenceResponse: JSON.stringify(projectReference),
    expectedFailure: { strictJson: false, productionValid: true, recovery: 'invalid_json_extra_closing_brace' }, criteria: criteria.project
  }
];

// The six stale-focus traces occurred with one, two, and three stale records.
// Preserve that variation so evaluation does not overfit one freshness mix.
for (const staleCount of [2, 3]) {
  const variant = clone(FAILURE_CASES[0]);
  variant.id = `stale-focus-with-${staleCount}-stale-projects`;
  variant.description = `An urgent-looking cached project attracts focus with ${staleCount} stale records among six projects.`;
  for (const project of variant.input.projects.filter(item => ['guide-refresh', 'handover-plan'].includes(item.projectId)).slice(0, staleCount - 1)) {
    project.state = 'stale'; project.assessedAt = '2031-04-01T12:00:00Z'; project.fallbackReason = 'PROVIDER_UNAVAILABLE';
  }
  const reference = JSON.parse(variant.referenceResponse);
  for (const project of variant.input.projects.filter(item => item.state === 'stale')) {
    reference.priorities.find(item => item.projectId === project.projectId).priorityReason = 'Stale context; obtain a current assessment.';
  }
  reference.summary = 'M1 is pending. Stale project assessments need a refresh before drawing new conclusions.';
  variant.referenceResponse = JSON.stringify(reference);
  FAILURE_CASES.push(variant);
}
