/* Fictional, in-memory interaction model. No API calls, storage, or actual AI. */
'use strict';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const demoNow = new Date('2026-09-21T08:45:00Z');
const priorityLabels = { focus: 'First', next: 'Next', maintain: 'Maintain', parked: 'Parked' };
const priorityOrder = { focus: 0, next: 1, maintain: 2, parked: 3 };
const projects = [
  { id: 'atlas', name: 'Atlas', outcome: 'Deliver the client portal', tier: 'focus', trajectory: 'At risk', tone: 'red', note: 'Scope decision blocks testing', next: 'Agree the launch scope', reason: 'Friday’s recorded delivery target leaves a short testing window.', source: 'atlas/status.md · Next action', quote: 'Next action: agree the release scope before final testing.\nTarget delivery: 2026-09-25.\nBlocker: the scope decision remains open.' },
  { id: 'beacon', name: 'Beacon', outcome: 'Validate the customer problem', tier: 'next', trajectory: 'Losing momentum', tone: '', note: 'No next test arranged', next: 'Book one customer conversation', reason: 'A small scheduling step protects the next validation milestone.', source: 'beacon/status.md · Next action', quote: 'Research synthesis complete.\nNext validation milestone: 2026-10-02.\nNext action: arrange a customer conversation. No date booked yet.' },
  { id: 'echo', name: 'Echo', outcome: 'Ship the public beta', tier: 'next', trajectory: 'Drifting', tone: '', note: 'Same milestone deferred twice', next: 'Choose a smaller beta scope', reason: 'The intended milestone is slipping while the scope keeps expanding.', source: 'echo/log.md · 2026-09-18', quote: '2026-09-11: beta deferred; added a reporting screen.\n2026-09-18: beta deferred again; added export settings.\nNo revised beta scope or target agreed.' },
  { id: 'cedar', name: 'Cedar', outcome: 'Make reporting dependable', tier: 'maintain', trajectory: 'On course', tone: 'green', note: 'Import acceptance check passed', next: 'Run the next scheduled check', reason: 'The recorded blocker is resolved and the next step is already clear.', source: 'cedar/log.md · 2026-09-20', quote: '2026-09-20: import acceptance check passed against all three agreed fixtures.\nThe data import blocker is resolved.\nNext scheduled check: 2026-09-28.' },
  { id: 'foxtrot', name: 'Foxtrot', outcome: 'Explore a new service idea', tier: 'maintain', trajectory: 'Needs an update', tone: 'neutral', note: 'Current status is missing', next: 'Record the current outcome', reason: 'There is not enough current evidence to justify moving this ahead of committed work.', source: 'foxtrot/index.md · Outcome', quote: 'Outcome: decide whether the service idea merits a small trial.\nCollector observation: status.md is missing. No current commitment can be established.' },
  { id: 'delta', name: 'Delta', outcome: 'Refresh the website', tier: 'parked', trajectory: 'Parked', tone: 'neutral', note: 'Deliberately paused', next: 'Revisit on 12 October', reason: 'You deliberately paused this project until October.', source: 'delta/status.md · Next action', quote: 'Paused by agreement until 2026-10-12.\nNext action: revisit the website refresh after the current delivery period.' }
];
const items = [
  { id: 'atlas-scope', project: 'atlas', urgency: 'Act now', tone: 'red', due: '2026-09-25', firstStep: 'Message Sam: “Can we do a 20-minute scope call today?”', title: 'Set the scope before the testing window closes.', description: 'The delivery plan still targets Friday. Final testing depends on an unresolved scope decision.', observation: 'The current status names a scope decision as the blocker to final testing. The delivery plan records 25 September.', inference: 'Leaving the decision open reduces the time available for testing. This is a delivery risk, even if other work is progressing.', action: 'Agree what is in the release and what can wait.', cta: 'Review the decision' },
  { id: 'beacon-conversation', project: 'beacon', urgency: 'Prevent drift', tone: '', due: '2026-10-02', firstStep: 'Pick one customer and draft a two-line invitation.', title: 'Keep Beacon moving with one customer conversation.', description: 'Research is complete, but the next test is not arranged. Booking it now protects the early-October milestone.', observation: 'The status records completed research and no booked customer conversation before the 2 October milestone.', inference: 'Arranging a conversation may need lead time. The project could lose momentum before the next validation step.', action: 'Choose one customer and prepare an invitation this week.', cta: 'Discuss next step' },
  { id: 'echo-scope', project: 'echo', urgency: 'This week', tone: '', firstStep: 'Write the one-sentence minimum beta scope in echo/status.md.', escalation: { note: 'Raised in 3 reviews without a response.', consequence: 'If no smaller scope is agreed before October, the 2 October check-in arrives with nothing finishable to show (echo/log.md).' }, title: 'Give Echo a smaller, finishable beta.', description: 'Two dated entries defer the same milestone while adding features. A narrower scope would restore a checkable next outcome.', observation: 'The 11 and 18 September log entries defer the beta and add features. Neither records an agreed replacement scope.', inference: 'The work is growing without advancing the stated beta outcome. This is a direction problem, not a lack of activity.', action: 'Choose the minimum beta scope and record its acceptance criteria.', cta: 'Discuss the scope' },
  { id: 'foxtrot-update', project: 'foxtrot', urgency: 'Prevent drift', tone: 'neutral', firstStep: 'Add three bullet status lines to foxtrot/status.md.', title: 'Bring Foxtrot’s status up to date.', description: 'There is an outcome in the index, but no current status. An update would let the next review assess it fairly.', observation: 'The collector could not find status.md. The index records the intended outcome only.', inference: 'There is not enough evidence to judge progress. No claim of drift is justified.', action: 'Record the latest outcome and the next useful check.', cta: 'Prepare an update' }
];
let state;
let reviewTimer;
let toastTimer;
let dialogOpener;

function resetDemo() {
  clearTimeout(reviewTimer);
  state = { preview: 'fresh', tab: 'today', showAll: false, feedback: {}, overrides: {}, guidance: [], questionAnswered: false, configured: true, automatic: true, limit: '6', revisedBriefing: false };
  $('#preview-state').value = 'fresh';
  render();
}

function announce(message) {
  clearTimeout(toastTimer);
  $('#announcement').textContent = message;
  toastTimer = setTimeout(() => { $('#announcement').textContent = ''; }, 6500);
}

function projectById(id) { return projects.find(project => project.id === id); }
function effectiveTier(project) { return state.overrides[project.id]?.tier || project.tier; }
const reportableProjects = ['atlas'];
const activity = {
  7: { echo: 46, atlas: 5, cedar: 8, beacon: 3, foxtrot: 0, delta: 0 },
  30: { echo: 112, atlas: 64, cedar: 31, beacon: 22, foxtrot: 4, delta: 0 }
};
const focusNotes = {
  7: 'Echo received 74% of the last 7 days of activity, while Atlas (First) recorded none since Wednesday. The review above weighs what that means; activity alone proves nothing.',
  30: 'Counts are chat turns plus changed files over 30 days — not hours, effort, or progress.'
};
function runwayLabel(due) {
  const days = Math.floor((new Date(`${due}T23:59:59Z`) - demoNow) / 86400000);
  return days <= 0 ? 'due today' : days === 1 ? '1 day left' : `${days} days left`;
}
function presetBeforeDue(due) {
  const at = new Date(`${due}T09:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 2);
  return at.toISOString().slice(0, 16);
}
function runwayChip(item) {
  return item.due ? `<span class="runway" title="Evidenced date: ${item.due}">${runwayLabel(item.due)}</span>` : '';
}
function sortedProjects() { return [...projects].sort((a, b) => priorityOrder[effectiveTier(a)] - priorityOrder[effectiveTier(b)] || projects.indexOf(a) - projects.indexOf(b)); }

const viewTabs = ['today', 'projects', 'focus'];
function selectTab(name, moveFocus = false) {
  state.tab = name;
  for (const tab of viewTabs) {
    const selected = tab === name;
    const button = $(`#tab-${tab}`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`#panel-${tab}`).hidden = !selected;
  }
  if (moveFocus) $(`#tab-${name}`).focus();
}

function render() {
  const mode = state.preview;
  const noReview = mode === 'setup' || mode === 'empty';
  $('#review-content').hidden = noReview;
  $('#setup-panel').hidden = mode !== 'setup';
  $('#empty-panel').hidden = mode !== 'empty';
  $('#review-button').disabled = mode === 'reviewing' || mode === 'empty';
  $('#review-button').innerHTML = mode === 'reviewing' ? 'Reviewing…' : '<span aria-hidden="true">↻</span> Review now';
  const metadata = {
    fresh: 'Reviewed 5 minutes ago · 6 of 6 projects assessed',
    reviewing: 'Reviewing changes… · Last completed 5 minutes ago',
    stale: 'Last reviewed 5 minutes ago · Changes since this review',
    failed: 'Last successful review yesterday, 09:40 · Latest attempt failed',
    paused: 'Last reviewed 5 minutes ago · Automatic reviews paused',
    setup: 'No review yet · 6 projects available',
    partial: 'Reviewed 5 minutes ago · 5 of 6 projects assessed this time',
    empty: 'No projects yet'
  };
  $('#review-meta').textContent = metadata[mode];
  $('#review-meta').title = 'Demonstration time: 21 September 2026, 09:45 Europe/Dublin';
  const notices = {
    reviewing: 'The last completed briefing stays available while the new review runs. This preview state does not call a provider.',
    stale: 'Project evidence or your guidance has changed. The briefing below is from the previous review.',
    failed: 'The latest review could not finish. Your last successful briefing is preserved. Try Review now to simulate recovery.',
    paused: 'Automatic reviews are paused. You can still request a one-off review, or resume in Monitoring.',
    partial: 'Foxtrot was not assessed in this run because the evidence budget was reached. Its older assessment is labeled below.'
  };
  $('#state-notice').hidden = !notices[mode];
  $('#state-notice').textContent = notices[mode] || '';
  $('#monitor-label').textContent = state.automatic ? 'Automatic reviews are on' : 'Automatic reviews are paused';
  $('#monitor-description').textContent = state.automatic ? `Changes and approaching dates · while Workbench is running · ${state.limit} attempts/day maximum` : 'Last briefing retained · manual review is available';
  if (state.revisedBriefing) {
    const focus = sortedProjects().find(project => effectiveTier(project) !== 'parked');
    $('#briefing-title').textContent = focus ? `Give ${focus.name} your attention today.` : 'Your projects are deliberately parked.';
    $('#briefing-summary').textContent = focus ? `${state.overrides[focus.id] ? 'Your priority correction puts this project first. ' : ''}${focus.reason} This is a simulated refresh of the fictional briefing.` : 'No active project needs a recommendation in this demo. Revisit your priorities when you are ready.';
  } else {
    $('#briefing-title').textContent = 'Give Atlas your attention today.';
    $('#briefing-summary').textContent = 'Friday’s delivery depends on a scope decision that is still open. A short decision now protects the testing window. Then make room for Beacon’s next customer conversation.';
  }
  selectTab(state.tab);
  renderAttention();
  renderProjects();
  renderFocus();
  $('#question-panel').hidden = state.questionAnswered;
  $('#project-nav').innerHTML = (mode === 'empty' ? [] : projects).map(project => `<button class="nav-item" data-project="${project.id}"><span class="nav-project-icon" aria-hidden="true">▱</span>${project.name}${['At risk', 'Losing momentum', 'Drifting'].includes(project.trajectory) ? `<span class="nav-dot ${project.tone}" aria-hidden="true"></span>` : ''}</button>`).join('');
  $('.project-count').textContent = mode === 'empty' ? '0' : String(projects.length);
}

function renderAttention() {
  const active = items.filter(item => !state.feedback[item.id]);
  const displayed = state.showAll ? active : active.slice(0, 3);
  $('#attention-count').textContent = String(active.length);
  $('#show-all').hidden = active.length <= 3;
  $('#show-all').textContent = state.showAll ? 'Show fewer' : `Show all ${active.length}`;
  $('#attention-list').innerHTML = displayed.length ? displayed.map((item, index) => `<article class="attention-item">
    <span class="item-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><div>
      <div class="item-topline"><span class="item-project">${projectById(item.project).name}</span><span class="badge ${item.tone}">${item.urgency}</span>${runwayChip(item)}</div>
      <h3 class="item-title">${escapeHtml(item.title)}</h3><p class="item-description">${escapeHtml(item.description)}</p>
      <p class="first-step"><strong>Start here (≈15 min)</strong> ${escapeHtml(item.firstStep)}</p>
      ${item.escalation ? `<p class="escalation-note"><strong>${escapeHtml(item.escalation.note)}</strong> ${escapeHtml(item.escalation.consequence)} You can also park this deliberately — no nudges until a date you choose.</p>` : ''}
      <div class="item-actions"><button data-discuss="${item.id}">${item.cta} <span aria-hidden="true">↗</span></button><button class="text-button" data-revisit="${item.id}">Revisit…</button>${item.escalation ? `<button class="text-button" data-park="${item.project}" data-park-issue="${item.id}">Park ${projectById(item.project).name}…</button>` : ''}<button class="text-button" data-correct="${item.id}">Correct assessment</button></div>
      <details class="evidence"><summary>Why this matters</summary><div class="evidence-content"><p><strong>Observed</strong> ${escapeHtml(item.observation)}</p><p><strong>Inferred</strong> ${escapeHtml(item.inference)}</p><p><strong>Proposed step</strong> ${escapeHtml(item.action)}</p><button class="text-button" data-source="${item.project}">${escapeHtml(projectById(item.project).source)} ↗</button><div class="item-actions"><button class="text-button" data-resolved="${item.id}">Resolved elsewhere</button><button class="text-button" data-dismiss="${item.id}">Dismiss this nudge</button></div></div></details>
    </div></article>`).join('') : '<p class="muted" style="padding:24px 0">No active nudges in this demo. Your deferred and dismissed items remain below.</p>';
  const deferred = items.filter(item => state.feedback[item.id]);
  $('#deferred-section').hidden = deferred.length === 0;
  $('#deferred-label').textContent = `Deferred and dismissed · ${deferred.length}`;
  $('#deferred-list').innerHTML = deferred.map(item => `<div class="deferred-row"><div><strong>${projectById(item.project).name}</strong> · ${escapeHtml(item.title)}<br>${escapeHtml(state.feedback[item.id].label)}</div><button class="text-button" data-undo="${item.id}" aria-label="Undo response for ${projectById(item.project).name}">Undo</button></div>`).join('');
}

function renderProjects() {
  $('#project-rows').innerHTML = sortedProjects().map(project => {
    const override = state.overrides[project.id];
    const partial = state.preview === 'partial' && project.id === 'foxtrot';
    const parked = effectiveTier(project) === 'parked';
    return `<tr class="${parked ? 'parked-row' : ''}"><td><button class="project-name" data-project="${project.id}">${project.name}</button><small>${project.outcome}</small>${reportableProjects.includes(project.id) ? `<button class="text-button report-link" data-report="${project.id}">Draft progress report ↗</button>` : ''}</td>
    <td data-label="Priority"><button class="priority-control ${override ? 'user-priority' : ''}" data-priority="${project.id}" aria-label="Change priority for ${project.name}">${priorityLabels[effectiveTier(project)]}<span aria-hidden="true">⌄</span><small>${override ? 'Your priority' : 'Inferred'}</small></button></td>
    <td data-label="Trajectory"><span class="badge ${parked ? 'neutral' : project.tone}">${parked ? 'Parked' : project.trajectory}</span><small class="trajectory-note">${partial ? 'Not included · assessed 18 Sep' : parked ? 'Deliberately paused' : project.note}</small></td>
    <td data-label="Next useful step">${parked ? (project.id === 'delta' ? project.next : 'Choose a date to revisit') : project.next}<small>${partial ? 'Older assessment retained' : 'Based on project records'}</small></td></tr>`;
  }).join('');
}

function openDialog(title, kicker, html) {
  const dialog = $('#action-dialog');
  if (!dialog.open) dialogOpener = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#dialog-kicker').textContent = kicker;
  $('#dialog-body').innerHTML = html;
  if (!dialog.open) dialog.showModal();
}
$('#action-dialog').addEventListener('close', () => {
  let target = dialogOpener?.isConnected ? dialogOpener : null;
  if (!target && dialogOpener?.dataset.priority) target = document.querySelector(`[data-priority="${CSS.escape(dialogOpener.dataset.priority)}"]`);
  (target || $('#review-button')).focus();
});
function closeDialog() { $('#action-dialog').close(); }
function cancelButton() { return '<button type="button" data-close>Cancel</button>'; }
function markStale(message) { state.preview = 'stale'; $('#preview-state').value = 'stale'; render(); announce(message); }

function sourceDialog(id) {
  const project = projectById(id);
  openDialog('Evidence behind the assessment', project.name.toUpperCase(), `<p class="source-path">${escapeHtml(project.source)}</p><blockquote class="source-quote">${escapeHtml(project.quote)}</blockquote><p>This is fictional source text for the mockup. In the application, this link opens the actual project document at the cited section.</p><div class="dialog-actions"><button data-close>Close evidence</button></div>`);
}

function priorityDialog(id) {
  const project = projectById(id);
  const override = state.overrides[id];
  openDialog('Change priority', project.name.toUpperCase(), `<p><strong>Current reasoning:</strong> ${project.reason}</p><p>Your correction takes precedence in future reviews. Changing priority does not complete work or set a deadline.</p><form id="priority-form">
    <label for="priority-tier">Priority<select id="priority-tier" name="tier">${Object.entries(priorityLabels).map(([value, label]) => `<option value="${value}" ${effectiveTier(project) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label for="priority-reason">What should the reviewer know?<textarea id="priority-reason" name="reason" maxlength="2000" placeholder="For example: Beacon is my main focus for the next two weeks.">${escapeHtml(override?.reason || '')}</textarea></label>
    <label for="priority-expiry">Expires on (optional)<input id="priority-expiry" name="expiry" type="date" min="2026-09-22" value="${escapeHtml(override?.expiry || '')}"></label>
    <div class="dialog-actions">${override ? '<button type="button" id="clear-priority">Use inferred priority</button>' : ''}${cancelButton()}<button class="primary-button">Save priority</button></div></form>`);
  $('#priority-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    state.overrides[id] = { tier: form.get('tier'), reason: form.get('reason'), expiry: form.get('expiry') };
    closeDialog(); markStale(`${project.name} priority saved in this demo. The project list has been reordered.`);
  });
  $('#clear-priority')?.addEventListener('click', () => { delete state.overrides[id]; closeDialog(); markStale(`${project.name} uses inferred priority again.`); });
}

function revisitDialog(id) {
  const item = items.find(value => value.id === id);
  openDialog('Give this a little time', projectById(item.project).name.toUpperCase(), `<p>${escapeHtml(item.title)}</p><p>This nudge stays deferred until your chosen time, even if the next review rephrases it.</p><form id="revisit-form"><label for="revisit-at">Revisit (Europe/Dublin)<input id="revisit-at" name="at" type="datetime-local" min="2026-09-21T09:46" value="2026-09-24T09:00" required></label><div class="preset-row">${item.due ? `<button type="button" class="text-button" data-preset="${presetBeforeDue(item.due)}">2 days before the evidenced date</button>` : ''}<button type="button" class="text-button" data-preset="2026-09-28T09:00">Next Monday morning</button></div><p>Dates use the fixed demonstration clock: 21 September 2026.</p><div class="dialog-actions">${cancelButton()}<button class="primary-button">Save revisit time</button></div></form>`);
  $('#revisit-form').addEventListener('click', event => { const preset = event.target.closest('[data-preset]'); if (preset) $('#revisit-at').value = preset.dataset.preset; });
  $('#revisit-form').addEventListener('submit', event => {
    event.preventDefault(); const at = new FormData(event.currentTarget).get('at');
    state.feedback[id] = { action: 'snooze', until: at, label: `Revisit ${at.replace('T', ' at ')} · Europe/Dublin` };
    closeDialog(); renderAttention(); $('#deferred-section').open = true; announce('Nudge deferred. Use Undo below the attention list to bring it back.');
  });
}

function guidanceDialog(projectId, issueId, question = false) {
  openDialog(question ? 'Add context to the priority decision' : 'Correct the assessment', projectId ? projectById(projectId).name.toUpperCase() : 'WORKSPACE', `<p>Your context informs the next review. It stays separate from independently verified project outcomes.</p><form id="guidance-form"><label for="guidance-text">What should the reviewer know?<textarea id="guidance-text" name="text" required maxlength="2000" placeholder="For example: work is happening elsewhere; the next checkpoint is Thursday."></textarea></label><div class="dialog-actions">${cancelButton()}<button class="primary-button">Save context</button></div></form>`);
  $('#guidance-form').addEventListener('submit', event => {
    event.preventDefault(); const text = new FormData(event.currentTarget).get('text').trim();
    if (!text) { $('#guidance-text').setCustomValidity('Enter some context.'); $('#guidance-text').reportValidity(); return; }
    state.guidance.push({ projectId, issueId, text }); if (question) state.questionAnswered = true;
    closeDialog(); markStale('Your context is saved in this demo. Review now to simulate an updated briefing.');
  });
  $('#guidance-text').addEventListener('input', event => event.target.setCustomValidity(''));
}

function parkDialog(projectId, issueId) {
  const project = projectById(projectId);
  openDialog('Park this project deliberately', project.name.toUpperCase(), `<p>Parking is a decision, not a failure. ${project.name} moves below active work and receives no nudges until your revisit date. Nothing in the project changes.</p><form id="park-form"><label for="park-until">Revisit on<input id="park-until" name="until" type="date" min="2026-09-22" value="2026-11-02" required></label><label for="park-reason">Why park it? (optional, guides the reviewer)<textarea id="park-reason" name="reason" maxlength="2000" placeholder="For example: deliberately shelved until the Atlas delivery is out."></textarea></label><div class="dialog-actions">${cancelButton()}<button class="primary-button">Park ${project.name}</button></div></form>`);
  $('#park-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const until = form.get('until');
    state.overrides[projectId] = { tier: 'parked', reason: form.get('reason') || 'Parked deliberately after repeated deferral.', expiry: until };
    if (issueId) state.feedback[issueId] = { action: 'snooze', until, label: `Parked with ${project.name} until ${until} · no nudges before then` };
    closeDialog(); markStale(`${project.name} is parked until ${until}. No nudges before then, and no shame attached.`);
  });
}

function feedbackDialog(id, action) {
  const item = items.find(value => value.id === id);
  const resolved = action === 'resolved';
  openDialog(resolved ? 'Record a resolution' : 'Dismiss this nudge', projectById(item.project).name.toUpperCase(), `<p>${resolved ? 'The reviewer will treat this as reported resolved by you. It does not mark the project task complete or claim independent verification.' : 'This nudge stays dismissed unless new evidence materially changes the concern. The project remains in the overview.'}</p><form id="feedback-form"><label for="feedback-reason">Context (optional)<textarea id="feedback-reason" name="reason" maxlength="2000"></textarea></label><div class="dialog-actions">${cancelButton()}<button class="primary-button">${resolved ? 'Record resolution' : 'Dismiss nudge'}</button></div></form>`);
  $('#feedback-form').addEventListener('submit', event => {
    event.preventDefault(); const reason = new FormData(event.currentTarget).get('reason');
    state.feedback[id] = { action, reason, label: resolved ? 'Reported resolved by you · not independently verified' : 'Dismissed for the current evidence' };
    closeDialog(); renderAttention(); $('#deferred-section').open = true; announce(resolved ? 'Recorded as resolved by you. No project file changed.' : 'Nudge dismissed. You can undo this below the attention list.');
  });
}

function chatDialog(itemId, projectId) {
  const item = items.find(value => value.id === itemId);
  const project = projectById(item?.project || projectId);
  const message = item ? `Help me with ${project.name}: ${item.action}\nStart with: ${item.firstStep}\n\nThe workspace review flagged: ${item.observation}\nSource: ${project.source}` : project ? `Help me assess the next useful step for ${project.name}.` : 'Help me compare priorities across my projects.';
  openDialog(project ? `Continue in ${project.name}` : 'Workspace chat', 'CHAT HANDOFF · PREVIEW', `<p>${project ? 'In the application, this action opens the project chat with this draft and its evidence links. An existing unsent draft is preserved.' : 'In the application, sending your first workspace message uses the existing confirmation for workspace-wide read and write access. A read-only review does not enable that mode.'}</p><label for="chat-draft">Prepared message<textarea id="chat-draft" rows="5">${escapeHtml(message)}</textarea></label><p>This mockup stops at the draft. No message is sent and no work starts.</p><div class="dialog-actions"><button data-close>Close preview</button></div>`);
}

function sessionDialog() {
  const top = items.find(item => !state.feedback[item.id]);
  const message = top ? `I have 30 minutes. Based on the current review, what's the best use of it?\n\nSuggested: ${projectById(top.project).name} — ${top.firstStep}\nIf that finishes early, stop there and record the outcome.` : 'I have 30 minutes. Based on the current review, what is the best use of it?';
  openDialog('A 30-minute session', 'CHAT HANDOFF · PREVIEW', `<p>In the application, this opens chat with a time-boxed draft built from the saved review. Nothing is sent until you choose Send, and preparing the draft makes no provider call.</p><label for="chat-draft">Prepared message<textarea id="chat-draft" rows="5">${escapeHtml(message)}</textarea></label><p>This mockup stops at the draft. No message is sent and no work starts.</p><div class="dialog-actions"><button data-close>Close preview</button></div>`);
}

function reportDialog(projectId) {
  const project = projectById(projectId);
  const report = ['# Atlas progress — 8–21 September 2026 (draft)', '', '**Headline:** Client portal on track for 25 September, pending one open scope decision.', '', '## Completed', '- Payment flow passed its acceptance checks (log.md, 12 Sep).', '- Client review of navigation recorded as signed off (log.md, 16 Sep).', '', '## In progress', '- Final testing prepared; start depends on the release-scope decision (status.md).', '', '## Blockers and risks', '- The open scope decision is shortening the testing window before 25 Sep.', '', '## Next steps', '- Agree the release scope; begin final testing.', '', '_Caveats: the navigation sign-off is recorded in the log but not independently verified._'].join('\n');
  openDialog('Draft progress report', `${project.name.toUpperCase()} · REPORTABLE`, `<p>Drafted from dated log entries and status since the previous report. Every completed claim cites recorded evidence; unverified items are labeled. <strong>Draft · verify before sending.</strong></p><label for="report-draft">Report draft (fictional)<textarea id="report-draft" class="report-draft" rows="14">${escapeHtml(report)}</textarea></label><p>The report is copy-only: it is never sent anywhere and never written into project files.</p><div class="dialog-actions"><button type="button" id="copy-report" class="primary-button">Copy report</button><button data-close>Close</button></div>`);
  $('#copy-report').addEventListener('click', () => { navigator.clipboard?.writeText($('#report-draft').value).catch(() => {}); announce('Report draft copied. Verify it before sending — nothing was sent by Workbench.'); });
}

function renderFocus(range = state.focusRange || 7) {
  state.focusRange = range;
  $('#focus-7').classList.toggle('selected', range === 7); $('#focus-7').setAttribute('aria-pressed', String(range === 7));
  $('#focus-30').classList.toggle('selected', range === 30); $('#focus-30').setAttribute('aria-pressed', String(range === 30));
  const counts = activity[range];
  const max = Math.max(...Object.values(counts), 1);
  $('#focus-rows').innerHTML = [...projects].sort((a, b) => counts[b.id] - counts[a.id]).map(project => `<div class="focus-row"><span>${project.name}<small>${priorityLabels[effectiveTier(project)]}</small></span><div class="focus-track"><div class="focus-bar ${counts[project.id] ? '' : 'dim'}" style="width:${Math.max(2, Math.round(counts[project.id] / max * 100))}%"></div></div><span class="focus-count">${counts[project.id]}</span></div>`).join('');
  $('#focus-note').textContent = focusNotes[range];
}

function monitoringDialog() {
  openDialog('A considered view, on your terms.', 'MONITORING', `<p>Review project instructions, status, and recent recorded outcomes with your chosen provider. Reviews cannot edit files or carry out tasks.</p><form id="monitor-form"><label for="review-model">Review model<select id="review-model"><option>Anthropic · Claude (subscription) — Recommended for reviews</option><option>OpenAI · GPT (API key) — Recommended · metered</option><option>Local · small model — Unverified for reviews</option></select></label><p class="muted" id="model-note">Recommended for reviews · uses your plan quota — no per-review charge. Production lists your configured providers with a review-capability tier and cost basis; picking a below-recommended or metered model asks for explicit confirmation. No silent fallback to another model, ever.</p><p class="muted">First time? Run one manual review and check its citations before switching on automatic reviews.</p><label class="check-label"><input type="checkbox" name="automatic" ${state.automatic ? 'checked' : ''}><span>Review automatically while Workbench is running<br><span class="muted">Check changed evidence and approaching dates. No monitoring while the server is stopped.</span></span></label><label for="daily-limit">Maximum automatic attempts per 24 hours<input id="daily-limit" name="limit" type="number" min="1" max="24" value="${state.limit}" required></label><label class="check-label"><input type="checkbox" name="tracking" checked><span>Keep a local focus report<br><span class="muted">Counts chat turns and file changes per project on this device. Activity is not progress. No content leaves Workbench.</span></span></label><p class="muted">Reportable projects: Atlas. Reportable projects offer Draft progress report in the project list.</p><p>6 projects included. Reviews use provider credits. Saved briefings cost nothing to open.</p><details><summary>Guidance stored in this demo (${state.guidance.length})</summary><div id="guidance-list">${state.guidance.length ? state.guidance.map((entry, index) => `<div class="guidance-entry"><button type="button" class="text-button" data-remove-guidance="${index}">Remove</button><strong>${entry.projectId ? projectById(entry.projectId).name : 'Workspace'}</strong><br>${escapeHtml(entry.text)}</div>`).join('') : '<p>No corrections recorded yet.</p>'}</div></details><p>Production stores guidance in Workbench on this device. This preview keeps changes only in memory.</p><div class="dialog-actions">${cancelButton()}<button class="primary-button">Save review settings</button></div></form>`);
  $('#review-model').addEventListener('change', event => {
    const notes = ['Recommended for reviews · uses your plan quota — no per-review charge.', 'Recommended for reviews · metered API billing — automatic reviews would ask you to confirm the per-review cost.', 'Unverified for reviews · saving would ask you to confirm: validation catches fabrication, but a weaker model can misjudge priorities with no visible error.'];
    $('#model-note').textContent = `${notes[event.target.selectedIndex]} Production enforces these rules; this mockup only previews the copy.`;
  });
  $('#monitor-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); state.automatic = form.has('automatic'); state.limit = form.get('limit'); state.configured = true;
    closeDialog(); clearTimeout(reviewTimer); state.preview = state.automatic ? 'fresh' : 'paused'; $('#preview-state').value = state.preview; render(); announce('Demo review settings saved. No provider was called.');
  });
}

function simulateReview() {
  if (!state.configured) { monitoringDialog(); return; }
  clearTimeout(reviewTimer); state.preview = 'reviewing'; $('#preview-state').value = 'reviewing'; render();
  reviewTimer = setTimeout(() => { state.preview = state.automatic ? 'fresh' : 'paused'; state.revisedBriefing = true; $('#preview-state').value = state.preview; render(); announce('Simulated review complete. Your corrections and deferred items are retained.'); }, 1200);
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-close')) { closeDialog(); return; }
  const data = button.dataset;
  if (data.source) sourceDialog(data.source);
  else if (data.priority) priorityDialog(data.priority);
  else if (data.revisit) revisitDialog(data.revisit);
  else if (data.discuss) chatDialog(data.discuss);
  else if (data.project) chatDialog(null, data.project);
  else if (data.correct) { const item = items.find(value => value.id === data.correct); guidanceDialog(item.project, item.id); }
  else if (data.park) parkDialog(data.park, data.parkIssue || null);
  else if (data.report) reportDialog(data.report);
  else if (data.dismiss) feedbackDialog(data.dismiss, 'dismiss');
  else if (data.resolved) feedbackDialog(data.resolved, 'resolved');
  else if (data.undo) { delete state.feedback[data.undo]; renderAttention(); announce('Response undone; the nudge is visible again.'); }
  else if (data.answer) {
    if (data.answer === 'The date has moved') { guidanceDialog('atlas', null, true); return; }
    state.guidance.push({ projectId: 'atlas', text: data.answer }); state.questionAnswered = true; markStale('Answer recorded. It will inform the next review.');
  }
  else if (data.removeGuidance !== undefined) { state.guidance.splice(Number(data.removeGuidance), 1); state.preview = 'stale'; $('#preview-state').value = 'stale'; render(); monitoringDialog(); announce('Guidance removed from this demo.'); }
  else if (data.document) openDialog(data.document, 'DOCUMENT NAVIGATION · PREVIEW', '<p>In the application, this opens the existing Markdown document view. The overview does not replace your workspace documents.</p><p>This standalone concept does not read your filesystem.</p><div class="dialog-actions"><button data-close>Back to overview</button></div>');
});
$('#show-all').addEventListener('click', () => { state.showAll = !state.showAll; renderAttention(); });
$('#question-other').addEventListener('click', () => guidanceDialog('atlas', null, true));
$('#review-button').addEventListener('click', simulateReview);
$('#reset').addEventListener('click', () => { resetDemo(); announce('Demo reset.'); });
$('#workspace-chat').addEventListener('click', () => chatDialog());
$('#session-button').addEventListener('click', sessionDialog);
$('.view-tabs').addEventListener('click', event => { const tab = event.target.closest('[role="tab"]'); if (tab) selectTab(tab.id.replace('tab-', '')); });
$('.view-tabs').addEventListener('keydown', event => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  const index = viewTabs.indexOf(state.tab);
  selectTab(viewTabs[(index + (event.key === 'ArrowRight' ? 1 : viewTabs.length - 1)) % viewTabs.length], true);
  event.preventDefault();
});
$('#focus-7').addEventListener('click', () => renderFocus(7));
$('#focus-30').addEventListener('click', () => renderFocus(30));
for (const selector of ['#monitoring-button', '#footer-monitoring', '#setup-button']) $(selector).addEventListener('click', monitoringDialog);
$('#create-project').addEventListener('click', () => openDialog('Create your first project', 'EXISTING WORKFLOW', '<p>The production overview opens the existing Create project dialog here. This mockup does not create files.</p><div class="dialog-actions"><button data-close>Back to overview</button></div>'));
$('#preview-state').addEventListener('change', event => {
  clearTimeout(reviewTimer); state.preview = event.target.value;
  state.configured = state.preview !== 'setup'; state.automatic = !['paused', 'setup'].includes(state.preview);
  render();
});
if (matchMedia('(max-width: 767px)').matches) $('.mobile-projects').open = false;
resetDemo();
