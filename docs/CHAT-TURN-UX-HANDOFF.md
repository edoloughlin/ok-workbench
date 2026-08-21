# Chat turn responsiveness and recovery handoff

## Scope

This note records an investigation into slow-looking chat turns and lost/inaccessible
responses in **OK Workbench**. The user is running the `ok-workspace` package on
macOS and authenticates the model provider with **GitHub Copilot**. This is not a
VS Code or GitHub Copilot Chat UI issue: the UI, turn lifecycle, notifications, and
workspace tools are implemented by this repository.

No source changes have been made as part of this investigation. A second review
verified the findings below against the code and produced the phased
implementation plan at the end of this document; implement the phases in order.

## User-observed behaviour

1. On macOS, a submitted prompt quickly shows an initial text such as “Let me
   check…”, followed by rapid tool activity (`list_files`, `read_file`,
   `list_workspace_files`, `extract_document`).
2. Afterwards, the chat can appear completely idle for as long as five minutes.
   The user often abandons it or changes project because there is no indication
   that processing continues.
3. `extract_document` is not the likely long-running operation in the reported
   case: it completes quickly and is followed immediately by other tool calls.
4. When an apparently abandoned turn completes, a notification is shown.
5. Clicking a completion notification while remaining in the same project can
   remove/hide the current foreground turn’s partial response and tool activity.
   The completed response associated with the notification is not reliably
   discoverable either.
6. Multiple outstanding turns may belong to the same chat thread. Their places
   in the thread are lost, so notifications are not a useful way to recover the
   individual completed result.

The user’s main requirement is not necessarily to expose private model reasoning.
They need durable, intelligible evidence that work is still taking place, and a
safe way to find every completed and in-progress turn.

## What the code does today

The relevant client is [`src/public/app.js`](../src/public/app.js). It talks to
the local HTTP server using an NDJSON stream, then uses the configured provider
(GitHub Copilot in this case).

### Turn state is browser-memory and DOM based

At `streamChatTurn` ([around line 780](../src/public/app.js#L780)) the client:

- Creates a local `turn` object and adds it to `activeChatTurns`, an in-memory
  `Set`.
- Immediately inserts a blank assistant message element into the current chat DOM.
- Accumulates streamed text in local `assistantText` and renders it into that DOM
  element.
- Does not persist partial assistant text or tool activity as a separately
  addressable local turn record.

The helper `isVisible()` ([around line 785](../src/public/app.js#L785)) says a
turn is visible whenever its project ID and thread ID equal the currently selected
project and thread. It does **not** check that its placeholder DOM element remains
attached to the displayed chat.

### Quiet periods have no generic activity indication

The streaming loop ([around line 794](../src/public/app.js#L794)) updates the UI
only for these received events:

- `message.delta` — append visible assistant text;
- `tool.completed` — append “Used …” activity;
- `scope.granted`;
- `workspace.changed`;
- `usage.updated` — update the status text;
- `turn.failed`.

There is no periodic client heartbeat, elapsed-time counter, “last event” display,
or explicit “processing tool results” state. Consequently, once the last tool
event has arrived, the UI remains still until the provider emits another event.
The application may present Pi thinking deltas as transient information while a
turn is active. They must never be persisted in thread history or diagnostics,
and must be removed as soon as normal response text begins. It can also show an
honest neutral status such as “Working — last activity 2m 14s ago; processing
tool results”.

### Notifications do not identify a turn

`addTurnNotification` ([around line 559](../src/public/app.js#L559)) stores:

```js
{ id: crypto.randomUUID(), projectId, projectTitle, threadId }
```

It omits the originating `turn.id`, original user prompt/summary, model, timestamp,
completion time, and any result locator. The notification label is generic:
“Chat turn complete · Open project.”

This makes it impossible to distinguish two turns that completed in the same
project and thread.

### Opening a notification reloads the whole thread

`openTurnNotification` ([around line 560](../src/public/app.js#L560)) removes the
notification immediately and, when it is for the current project, sets
`chatThreadId` and calls `loadChatThread(chatThreadId)`.

`loadChatThread` re-renders the chat history wholesale. An active turn’s partial
assistant element and its tool activity are only in the previous DOM, so they are
removed by that reload. Because `isVisible()` still returns true for an active turn
in that same project/thread, later deltas are rendered into its old, detached DOM
element. The user sees no updates until a later full reload, if one happens. This
explains the report that clicking a notification appears to lose the foreground
turn.

At normal final completion, the server persists the final assistant message and
emits `message.completed`/`turn.completed` (see [`src/server.js`](../src/server.js)
around lines 971–989). The client currently ignores those explicit completion
events; it simply treats EOF as success, sets `completed = true`, and then adds
the insufficient notification.

## Conclusions

1. The post-tool silence is real from the user’s perspective. It could represent
   provider/model processing, a provider-side delay, or a lack of emitted usage
   events; it is not evidence that visible reasoning text has been suppressed.
2. The macOS/Linux performance difference is not diagnosed yet. The browser client
   has no OS branch in this code path, so measure the provider/server stream before
   attributing it to macOS. The provider is GitHub Copilot, but it is accessed via
   OK Workbench’s local server.
3. The lost-response issue has a specific client-side cause: thread reloads discard
   in-progress DOM-only rendering, and notifications lack per-turn identity.
4. The current notification design is destructive for concurrent turns. It should
   not reload or replace an unrelated active presentation merely to open a result.
5. See “Additional findings” below: the destruction also happens on *normal
   completion* of a visible turn, the harness suppresses all non-text provider
   events (including silent retries), and macOS pays a measurable per-worker
   sandbox startup cost.

## Additional findings (verified against the code, second review)

These were confirmed by direct inspection and must be addressed by the plan below.

1. **Normal completion of a visible turn destroys concurrent turns.** At
   [`app.js` line 797](../src/public/app.js#L797), when a visible turn completes
   the client calls `await loadChatThreads()`, which reloads and re-renders the
   thread wholesale. Any *other* turn still streaming in that thread has its DOM
   node detached at that moment. Two concurrent turns in one thread therefore
   break each other even if the user never clicks a notification.
2. **Notifications fire even for turns the user watched complete.** The `finally`
   block at [`app.js` line 799](../src/public/app.js#L799) calls
   `addTurnNotification(turn)` unconditionally whenever `completed` is true,
   visible or not. This is notification noise.
3. **The server already emits `tool.started` and `tool.failed`**
   ([`server.js` line 984](../src/server.js#L984)) but the client only handles
   `tool.completed`. Rendering "Running `extract_document`…" on `tool.started` is
   an almost-free liveness improvement; workspace tools may run up to 10 minutes.
4. **The server forwards only text deltas from the Pi session.** In
   [`pi-harness.mjs` line 330](../src/pi-harness.mjs#L330) the session
   subscription forwards only `message_update` events whose
   `assistantMessageEvent.type` is `text_delta`. Thinking/reasoning phases and
   Pi's silent retry machinery (`retry: { enabled: true, maxRetries: 2 }` at
   line 268) produce **zero** client-visible events. A provider rate limit
   (e.g. a Copilot 429 with retry-after) looks exactly like a multi-minute dead
   stream. This is the most likely cause of the reported five-minute silences and
   is **not** macOS-specific.
5. **macOS has a real but bounded sandbox overhead.** Every turn spawns a fresh
   sandboxed Node worker via `sandbox-exec` (Seatbelt), and every
   `run_workspace_tool` call spawns *another* one
   ([`pi-harness.mjs` line 302](../src/pi-harness.mjs#L302)): `mkdtemp` + profile
   setup + cold Node boot each time. This plausibly adds seconds per tool-heavy
   turn versus bubblewrap on Linux, but does not explain multi-minute stalls.
   Measure before optimising (Phase 0 below).

## Implementation plan

The plan is split into small, independently verifiable phases. **Implement them in
order.** Each phase lists exact files, functions, and acceptance criteria. Do not
restructure unrelated code, do not rename existing events, and keep the existing
single-file style of [`src/public/app.js`](../src/public/app.js) and
[`src/server.js`](../src/server.js).

Hard constraints for every phase:

- Thinking/reasoning deltas may be rendered only as transient in-memory UI
  information. Never persist them in thread history or include their text in
  diagnostics; remove them when normal response text begins.
- Never log prompt text, message content, or credentials in diagnostics; log
  lengths, types, IDs, and timestamps only.
- Do not change the wire format of existing NDJSON events; only add new event
  types and new optional fields.
- Run the existing test suite (`npm test`) after each phase and keep it green.

### Phase 0 — Flag-gated turn diagnostics (do this first)

Goal: structured, timestamped logging that distinguishes provider silence from
local stalls, so the macOS question can be answered with data.

**Flag.** Diagnostics are OFF by default and enabled only when
`OK_WORKBENCH_TURN_DIAGNOSTICS=1` (accept `OKF_WORKBENCH_TURN_DIAGNOSTICS=1` as an
alias, matching the existing `OK_WORKBENCH_DIRECT_PROVIDER`/`OKF_...` convention at
[`server.js` line 658](../src/server.js#L658)). Read the flag once into a
module-level constant, e.g.:

```js
const TURN_DIAGNOSTICS = process.env.OK_WORKBENCH_TURN_DIAGNOSTICS === '1'
  || process.env.OKF_WORKBENCH_TURN_DIAGNOSTICS === '1';
```

**Server (`src/server.js`).**

- In `turnWriter` ([line 646](../src/server.js#L646)), when the flag is set, log
  each event as it is written using the existing `log()` helper (which already
  prefixes an ISO timestamp):
  `log('[ok-workbench] turn-event', { turnId, threadId, type, sequence, deltaLength })`
  where `deltaLength` is `payload.delta?.length` (never the delta text). Skip
  logging entirely when the flag is off — no object allocation on the hot path.
- In the turn POST handler (around [line 963](../src/server.js#L963)), when the
  flag is set, log turn start (`provider`, `model`, `effort`, `turnId`,
  `threadId`, `project`, message length only) and turn end (`turnId`, outcome
  `completed`/`failed`/`cancelled`, total duration in ms, reply length).

**Harness (`src/pi-harness.mjs`).**

- In `createTurnWorker`, when the flag is set (read it the same way in this
  module), record `Date.now()` before spawn and log after `waitForReady()`
  resolves: `logError` is for errors; add a `log` import or use
  `console.log` consistent with the module's existing logging. Log:
  `{ backend, network, spawnToReadyMs }`. This directly measures the macOS
  Seatbelt worker-startup cost per turn and per `run_workspace_tool` call.
- In `runPiTurn`, when the flag is set, extend the existing
  `session.subscribe` callback to log every event's `type` (and
  `assistantMessageEvent.type` when present) with a timestamp — types only,
  never content. This reveals whether the provider is silent or the harness is
  dropping events.

**Acceptance criteria.**

- With the flag unset, server output is byte-identical to today.
- With the flag set, a single chat turn produces: turn start line, one line per
  NDJSON event, worker spawn timing line(s), one line per Pi session event type,
  turn end line with duration.
- Comparing a macOS and a Linux run of the same prompt now shows where time is
  spent: worker spawn, tool execution, or provider gaps between session events.

### Phase 1 — Forward liveness status from the harness (`turn.status` event)

Goal: the client can show honest "still working" states during quiet periods.

**New NDJSON events.** `turn.status` with payload `{ state }` where `state` is one
of: `thinking`, `responding`, `retrying`. No other fields. `turn.thinking` has
payload `{ delta }`; it is forwarded to the browser for transient display only
and is never persisted or included in diagnostics.

**Harness (`src/pi-harness.mjs`).**

- Add an optional `onStatus` callback parameter to `runPiTurn` (alongside
  `onDelta`/`onTool`).
- In the `session.subscribe` callback at [line 330](../src/pi-harness.mjs#L330),
  extend the handler:
  - Keep the existing `text_delta` → `onDelta` behaviour unchanged.
  - Before implementing, inspect the Pi SDK's session event types (see the pi
    package docs referenced in the repo's development environment, or log event
    types via the Phase 0 diagnostics) to find the exact type names for
    (a) thinking/reasoning deltas and (b) auto-retry notifications.
  - When a thinking/reasoning delta event is seen, call
    `onStatus?.({ state: 'thinking' })` and `onThinking?.(delta)`. When a `text_delta` is seen, call
    `onStatus?.({ state: 'responding' })`. When a retry event is seen, call
    `onStatus?.({ state: 'retrying' })`.
  - Throttle: keep a `lastState` variable and only invoke `onStatus` when the
    state *changes*, never per delta.
  - If an event type cannot be identified with certainty, ignore it. Unknown
    events must not throw and must not emit a status.

**Server (`src/server.js`).**

- In `providerStream` ([line 650](../src/server.js#L650)), accept and pass
  through an `onStatus` option to `runPiTurn` (the direct Anthropic/OpenAI HTTP
  path may ignore it).
- In the turn POST handler, pass
  `onStatus: status => writeEvent('turn.status', { state: status.state })` and
  `onThinking: delta => writeEvent('turn.thinking', { delta })`.

**Acceptance criteria.**

- A turn against a reasoning model emits at least one
  `turn.status {state:'thinking'}` before the first `message.delta`.
- Existing tests in [`test/chat.test.mjs`](../test/chat.test.mjs) still pass
  (clients that ignore `turn.status` are unaffected).
- Add a server test asserting `turn.status` events are well-formed when present
  and contain only `type`, `thread_id`, `turn_id`, `sequence`, `state`.

### Phase 2 — Persist turn identity on assistant messages

Goal: a completed turn's final message is findable later.

**Server (`src/server.js`).**

- In the completion write at [line 989](../src/server.js#L989), add
  `turnId` to the persisted assistant message object:
  `current.messages.push({ id: ..., role: 'assistant', content: reply, model, effort: ..., turnId, createdAt: ... })`.
- Existing threads without `turnId` on messages must keep loading; treat the
  field as optional everywhere.

**Client (`src/public/app.js`).**

- In `renderChatMessages` ([line 673](../src/public/app.js#L673)) and
  `addChatMessage` ([line 686](../src/public/app.js#L686)), when a message has a
  `turnId`, set `node.dataset.turnId = message.turnId` on the message element so
  it can be located with `[data-turn-id="..."]`.

**Acceptance criteria.**

- New assistant messages in thread JSON files carry `turnId`.
- Old thread files load and render unchanged.

### Phase 3 — Client turn registry; render live turns from state, not retained DOM

Goal: fix the lost-response bugs. This is the core phase; keep it mechanical.

**Data model (`src/public/app.js`).** Extend the existing `turn` object created
in `streamChatTurn` ([line 782](../src/public/app.js#L782)) — keep using the
existing `activeChatTurns` Set — with these fields:

```js
const turn = {
  abort: new AbortController(),
  id: null,                    // server turn_id, set on turn.started (existing)
  clientId: crypto.randomUUID(), // stable key before turn.started arrives
  projectId: chatProjectId,
  projectTitle: ...,           // existing
  threadId: chatThreadId,
  unread: false,               // existing
  promptPreview: message.slice(0, 120),
  model, effort: chatUi.effort.value, initiator,
  status: 'working',           // 'working' | 'completed' | 'failed' | 'cancelled'
  startedAt: Date.now(),
  lastEventAt: Date.now(),
  lastActivityLabel: 'Started',
  assistantText: '',
  activities: [],              // [{ kind: 'tool'|'scope', label, at, done }]
  error: null,
};
```

Also add a module-level `const recentTurns = new Map();` (keyed by `clientId`)
that keeps the last 20 finished turns so notifications can still resolve them.
When a turn finishes, move it from `activeChatTurns` into `recentTurns` (evict
oldest beyond 20).

**Single render function.** Add `renderActiveTurn(turn)`:

1. Look up the turn's live DOM element with
   `chatUi.messages.querySelector(`[data-client-turn-id="${turn.clientId}"]`)`.
2. If it does not exist **and** the turn is currently visible
   (`chatProjectId === turn.projectId && chatThreadId === turn.threadId`), create
   it via `addChatMessage('assistant', '', ...)` and set
   `node.dataset.clientTurnId = turn.clientId` (and `data-turn-id` once `turn.id`
   is known) on the message element.
3. Render `turn.assistantText` into its body with `renderAssistantMarkdown`,
   render `turn.activities` as the existing `chat-tool-activity` paragraphs
   **inside/adjacent to the turn's own element** (not appended loosely to
   `chatUi.messages` as today), and render the status line (Phase 4).
4. If the element exists but `!element.isConnected`, drop the stale reference
   path entirely — step 1 always re-queries the live DOM, which is the point.

**Rewire `streamChatTurn`.** In the event loop
([line 794](../src/public/app.js#L794)):

- Every event updates the turn record first (`turn.lastEventAt = Date.now()`),
  then calls `renderActiveTurn(turn)` if visible. Concretely:
  - `message.delta` → `turn.assistantText += delta; turn.lastActivityLabel = 'Response text';`
  - `tool.started` → push `{ kind:'tool', label: event.tool, at: Date.now(), done:false }`
    to `turn.activities`; `turn.lastActivityLabel = event.tool;`
  - `tool.completed` → mark the matching last un-done activity `done:true`
    (or push one if none); keep the existing `create_project` link behaviour.
  - `tool.failed` → mark activity done with a failure note.
  - `turn.status` → `turn.lastActivityLabel = state` (mapped to friendly text).
  - `scope.granted`, `usage.updated`, `workspace.changed`, `turn.failed`:
    keep current behaviour, but route any DOM writes through `renderActiveTurn`.
- Remove the captured `assistantBody` streaming target and the local
  `assistantText` accumulator; the registry record is the single source of truth.
- On EOF/completion set `turn.status = 'completed'` and `turn.completedAt`;
  on error set `'failed'` (or `'cancelled'` for `AbortError`) and `turn.error`.

**Recompose after thread loads.** At the end of `renderChatMessages`
([line 673](../src/public/app.js#L673)), after rendering persisted messages,
iterate `activeTurnsFor(chatProjectId, chatThreadId)` and call
`renderActiveTurn(turn)` for each, **skipping** any turn whose final assistant
message is already present (`turn.id` matches a rendered `[data-turn-id]`). This
single change fixes both destruction paths (notification click and
completion-triggered `loadChatThreads`).

**Remove the destructive reload.** In the completion path
([line 797](../src/public/app.js#L797)), keep `await loadChatThreads()` (it is
needed to refresh titles and persisted history) — the recomposition step above
makes it safe. Verify with the Phase 6 tests.

**Acceptance criteria.**

- Start two turns in one thread; both stream visibly; when the first completes,
  the second's partial output remains visible and keeps updating.
- Switch project and back during a turn: partial output re-appears and continues.

### Phase 4 — Honest liveness UI

Goal: no silent minutes.

**Client (`src/public/app.js`).**

- Give each active turn's element a status line (one `<p>` with a dedicated
  class, rendered by `renderActiveTurn`), e.g.:
  `Working · 01:42 · last activity: extract_document 00:05 ago`.
- Add one module-level `setInterval` of 1 s that, when any active turn is
  visible, re-renders only the status lines (elapsed = `Date.now() - startedAt`;
  last activity = `Date.now() - lastEventAt`). Stop/skip when no active turns.
- After 20 s without events (`Date.now() - turn.lastEventAt > 20_000`), the
  status line reads `Still working — processing previous results` (plus the
  timers). Never imply an error.
- Map `turn.status` states: `thinking` → "Model is thinking", `retrying` →
  "Provider busy — retrying", `responding` → "Writing response".
- Render `tool.started` immediately as `Running <tool>…`, flipping to the
  existing `Used <tool>` on `tool.completed`.
- Add a global, persisted **Show thinking** toggle in the live **Model is
  thinking** status line, immediately before **Cancel**. When enabled, show
  accumulated `turn.thinking` text transiently; when normal response text
  begins, clear it. The setting applies across every project.
- Keep the existing Stop button working; it already targets
  `currentChatTurn()`. Additionally render a small per-turn Cancel control in
  the turn's status line wired to that exact turn's `cancelChatTurn`-equivalent
  (`DELETE /api/chat/threads/:threadId/turns/:turnId` + `turn.abort.abort()`).

**Acceptance criteria.**

- During a simulated 60 s provider silence, the visible turn shows a ticking
  elapsed timer and the quiet-threshold message, and Cancel still works.

### Phase 5 — Notification identity and non-destructive open

Goal: notifications identify a specific turn and never damage other turns.

**Client (`src/public/app.js`).**

- `addTurnNotification` ([line 559](../src/public/app.js#L559)): store
  `{ id, clientTurnId: turn.clientId, turnId: turn.id, projectId, projectTitle,
  threadId, promptPreview: turn.promptPreview, status: turn.status,
  completedAt: turn.completedAt }`.
- In the `finally` block of `streamChatTurn` ([line 799](../src/public/app.js#L799)),
  only call `addTurnNotification(turn)` when the turn was **not** visible at
  completion (`if (completed && !visible) addTurnNotification(turn)`).
- `renderTurnNotifications` ([line 545](../src/public/app.js#L545)): show
  `promptPreview`, project title, and completion time instead of the generic
  label; add an explicit Dismiss control per notification.
- `openTurnNotification` ([line 560](../src/public/app.js#L560)):
  1. Do **not** remove the notification up front; remove it only after the steps
     below succeed (Dismiss removes without opening).
  2. Navigate as today (switch project if needed, set `chatThreadId`, load the
     thread). Thanks to Phase 3 this no longer harms in-flight turns.
  3. After the thread renders, locate the result:
     `chatUi.messages.querySelector(`[data-turn-id="${notification.turnId}"]`)`,
     falling back to `[data-client-turn-id="${notification.clientTurnId}"]`;
     `scrollIntoView({ block: 'center' })` and add a brief highlight class.
  4. If not found (e.g. history trimmed), keep the notification and set the chat
     status to a clear message instead of failing silently.

**Acceptance criteria.**

- Two turns completing in the same thread produce two distinguishable
  notifications; opening each scrolls to and highlights the correct message.
- Opening a notification while another turn streams in that thread leaves the
  streaming turn intact (covered by tests below).
- Watching a turn complete produces no notification.

### Phase 6 — Tests

Server tests live in [`test/chat.test.mjs`](../test/chat.test.mjs) and already
assert `turn.completed`. Add:

1. `turn.status` events (when emitted) are well-formed (Phase 1).
2. Persisted assistant messages include `turnId`; pre-existing thread files
   without it still load (Phase 2).
3. Diagnostics flag off ⇒ no `turn-event` log lines; flag on ⇒ lines present and
   free of message content (Phase 0). Use a captured logger or spawn with the
   env var set.

Client-level coverage (unit or browser tests, following whatever pattern exists
in `test/`; if none exists for the client, add DOM-level tests with a minimal
harness rather than skipping):

4. Start two turns in one thread; render partial output for each; complete one;
   assert the other's partial output is still attached and later deltas render
   (regression for additional finding 1).
5. Reload/focus the thread through a notification during an active turn; assert
   the active turn's output is preserved and continues updating.
6. Notifications carry `turnId`/`clientTurnId`, prompt preview, and completion
   timestamp; opening one focuses the correct message; Dismiss removes without
   navigation.
7. No notification is created for a turn that completed while visible.
8. With no stream events for a simulated interval, elapsed/last-activity text
   updates and the per-turn Cancel remains wired to the right turn.
9. Simulate completion while the turn's thread is not selected; open it via the
   notification; assert final text and tool history are visible.

### Phase 7 (after diagnostics data) — macOS latency follow-up

Do **not** start this phase until Phase 0 data from a real macOS run exists.

- If `spawnToReadyMs` dominates: reuse one file-tool worker per turn is already
  the case; the candidate fix is pooling/reusing workers across turns and/or
  caching the worker for repeated `run_workspace_tool` calls with identical
  policy within a turn. Keep the sandbox model unchanged; only lifetimes change.
- If gaps between Pi session events dominate: the silence is provider-side
  (Copilot reasoning or rate-limit retries). Phase 1/4 already make this honest
  in the UI; no further local fix applies.
- If NDJSON write-to-render gaps dominate: investigate client transport, but
  this is not expected given the code inspection.

## Important corrections to earlier discussion

Earlier speculation about the ChatGPT/Codex app and VS Code was incorrect and
should be ignored. The relevant product is this OK Workbench repository using
GitHub Copilot authentication. The code inspection above is the basis for the
current conclusions.
