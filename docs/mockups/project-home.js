/* Fictional, in-memory project-home concept. No API calls, storage, or actual AI. */
'use strict';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const projects = ['Atlas', 'Beacon', 'Echo', 'Cedar', 'Foxtrot', 'Delta'];
let toastTimer;
let dialogOpener;

function announce(message) {
  clearTimeout(toastTimer);
  $('#announcement').textContent = message;
  toastTimer = setTimeout(() => { $('#announcement').textContent = ''; }, 6500);
}

function openDialog(title, kicker, html) {
  const dialog = $('#action-dialog');
  if (!dialog.open) dialogOpener = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#dialog-kicker').textContent = kicker;
  $('#dialog-body').innerHTML = html;
  if (!dialog.open) dialog.showModal();
}
$('#action-dialog').addEventListener('close', () => { (dialogOpener?.isConnected ? dialogOpener : $('#discuss-button')).focus(); });
function closeDialog() { $('#action-dialog').close(); }

const dialogs = {
  priority: () => openDialog('Change priority', 'ECHO', '<p>The production dialog is identical to the overview\u2019s: tier, optional expiry, and a note for the reviewer. Saving here uses the same controls API and marks the overview briefing stale.</p><div class="dialog-actions"><button data-close>Close preview</button></div>'),
  park: () => openDialog('Park this project deliberately', 'ECHO', '<p>Parking is a decision, not a failure. Echo would move below active work with no nudges until your revisit date \u2014 the same control as the overview\u2019s <strong>Park Echo\u2026</strong>.</p><div class="dialog-actions"><button data-close>Close preview</button></div>'),
  correct: () => openDialog('Correct the assessment', 'ECHO', '<p>Your context is stored as guidance for the next review, exactly as on the overview. It never edits project files.</p><div class="dialog-actions"><button data-close>Close preview</button></div>')
};

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-close')) { closeDialog(); return; }
  if (button.dataset.dialog) { dialogs[button.dataset.dialog](); return; }
  if (button.dataset.preview) {
    openDialog(button.dataset.preview, 'DOCUMENT NAVIGATION · PREVIEW', '<p>In the application, this opens the existing Markdown document view at the cited section. This standalone concept does not read your filesystem.</p><div class="dialog-actions"><button data-close>Back to project</button></div>');
  }
});

$('#strip-dismiss').addEventListener('click', () => {
  $('#strip').hidden = true;
  announce('Notice dismissed for its current evidence. The Atlas item itself is unchanged on the overview.');
});

$('#brief-toggle').addEventListener('click', () => {
  const body = $('#brief-body');
  const collapsed = !body.hidden;
  body.hidden = collapsed;
  $('#brief-toggle').textContent = collapsed ? 'Expand brief' : 'Collapse brief';
  $('#brief-toggle').setAttribute('aria-expanded', String(!collapsed));
});

$('#session-button').addEventListener('click', () => {
  const message = 'I have 30 minutes for Echo. Best use of it?\n\nSuggested: write the one-sentence minimum beta scope in echo/status.md.\nIf that finishes early, stop there and record the outcome.';
  openDialog('A 30-minute session', 'CHAT HANDOFF · PREVIEW', `<p>Opens this project\u2019s chat with a time-boxed draft from the saved review. Nothing sends until you choose Send; no provider call builds the draft.</p><label for="chat-draft">Prepared message<textarea id="chat-draft" rows="5">${escapeHtml(message)}</textarea></label><div class="dialog-actions"><button data-close>Close preview</button></div>`);
});

$('#discuss-button').addEventListener('click', () => {
  const message = 'Help me with Echo: choose the minimum beta scope and record its acceptance criteria.\nStart with: write the one-sentence minimum beta scope in echo/status.md.\n\nThe workspace review flagged: the 11 and 18 September log entries defer the beta and add features.\nSource: echo/log.md · 2026-09-18';
  openDialog('Continue in Echo', 'CHAT HANDOFF · PREVIEW', `<p>Prefills the existing project chat with the item and its evidence links. An existing unsent draft is preserved.</p><label for="chat-draft">Prepared message<textarea id="chat-draft" rows="6">${escapeHtml(message)}</textarea></label><div class="dialog-actions"><button data-close>Close preview</button></div>`);
});

$('#project-chat').addEventListener('click', () => openDialog('Project chat', 'EXISTING WORKFLOW', '<p>The existing Echo chat pane opens here, unchanged. The brief adds context above the documents; it does not alter chat behavior or permissions.</p><div class="dialog-actions"><button data-close>Close preview</button></div>'));

$('#reset').addEventListener('click', () => {
  $('#strip').hidden = false;
  $('#brief-body').hidden = false;
  $('#brief-toggle').textContent = 'Collapse brief';
  $('#brief-toggle').setAttribute('aria-expanded', 'true');
  announce('Demo reset.');
});

$('#project-nav').innerHTML = projects.map(name => `<button class="nav-item ${name === 'Echo' ? 'selected' : ''}" data-preview="${name} project home"><span class="nav-project-icon" aria-hidden="true">▱</span>${name}${['Atlas', 'Beacon', 'Echo'].includes(name) ? `<span class="nav-dot ${name === 'Atlas' ? 'red' : ''}" aria-hidden="true"></span>` : ''}</button>`).join('');
if (matchMedia('(max-width: 767px)').matches) $('.mobile-projects').open = false;
