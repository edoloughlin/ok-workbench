# Model and token usage reporting

Add a local usage ledger and a workspace-wide reporting overview that explain when models run, which models run, and which projects and activities consume tokens. Capture every Workbench-initiated inference attempt, including user prompts, tool continuations, project assessments, workspace synthesis, and failed or retried requests.

**Status:** Proposed implementation contract for 6.1-terra. This document specifies new behavior, not shipped functionality. Requirements marked **must** are release requirements; implement the complete acceptance matrix before declaring completion.

## Before you begin

- Use the existing Node.js 22.19+ application, vanilla browser UI, and test harness. Automated acceptance tests require no provider credentials.
- Read `src/server.js`, `src/pi-harness.mjs`, `src/review-submission.mjs`, `src/workspace-review-pipeline.js`, `src/workspace-review.js`, and the existing review and harness tests.
- Inspect the installed Pi runtime's supported request and usage hooks before choosing an interception point. Do not assume session events expose compaction, hidden retries, or physical model routing.
- Preserve existing capability boundaries, review request caps, cancellation, output limits, provider selection, and streaming behavior. Reporting must not trigger model requests.
- Work in authored `src/` files; do not hand-edit generated `dist/`. Follow existing build and security conventions.

## Define the implementation scope

### Required outcomes

- Persist model identity, attribution, lifecycle, and available token counts for every inference attempt initiated by Workbench, whether manual or automatic, local or remote, successful or unsuccessful.
- Report token totals and model request counts over time, by project, by activity, by provider/model, and by individual review run or chat operation.
- Provide hourly reporting for the last 24 hours, daily reporting for the last 30 days, weekly reporting for the last year, monthly reporting, and custom ranges.
- Keep history across restarts, model configuration changes, conversation deletion, and review-cache cleanup.
- Expose incomplete accounting honestly. An unknown token count is not zero, and provider-reported tokens are not necessarily a billing statement.

### Boundaries

The first release covers the current served workspace. Separate workspaces sharing an application-state directory must remain isolated. Cross-workspace dashboards, budgets, alerts, provider invoice reconciliation, currency estimates, remote telemetry, and semantic analysis of prompts are out of scope.

“All use” means all inference initiated by Workbench or its embedded model runtime. It does not include independent provider activity, other applications, or model requests made inside arbitrary user-authored tools that Workbench cannot observe. State this boundary in the report help text. Tool execution itself, credential refresh, model catalog retrieval, and ordinary HTTP search/fetch are not inference requests; a future model-backed tool must use the same accounting boundary.

Do not store prompt bodies, assistant text, reasoning text, tool arguments/results, credentials, endpoint URLs, or raw error bodies in the ledger. “User prompt logging” means recording an accepted prompt's operation metadata and all inference it causes, not duplicating conversation content. Do not estimate a separate user-text token count by subtracting context: model input includes system instructions, history, evidence, tool results, and repeated context.

## Design the reporting experience

### Place the entry point

Add a persistent **Usage** link with a small three-bar icon to `.topbar-actions`, immediately before **Chat**. Use the existing toolbar typography, spacing, and theme tokens; keep the link quieter than primary actions. On narrow screens, retain the icon with accessible name **Usage reporting** and a visible tooltip on focus. Do not add a changing token badge to the global toolbar.

Open `/usage/`, a reserved application route outside the `/workspace/` file namespace. Render the report in the main document area, with the normal shell and navigation intact. Show **Workspace / Usage** as breadcrumbs. Hide the chat pane and splitter only while reporting is active, restoring their previous visibility and width on return. Do not cancel running turns or change the selected chat project. Browser Back restores the prior page, scroll position, and draft.

Add secondary **View usage** links to project review details and workspace monitoring/review details. Project links preselect that project; review-run links preselect that run. These are shortcuts to the same reporting page, not separate reporting implementations. Keep the existing **Focus report** and **Draft progress report** names and behavior distinct: neither is token reporting.

### Use a restrained ledger layout

The visual direction is an editorial ledger: one generous total, a thin horizontal activity timeline, and precise numeric tables. Avoid a grid of dashboard cards, pie charts, decorative gradients, and a new design system. Reuse application fonts, with tabular numerals for quantities and restrained monospace styling for model IDs. Use one accent for uncached input, a quieter pattern for cached input, and a contrasting theme-safe tone for output. Never rely on color alone.

```text
+----------------------------------------------------------------------------+
| OK Workbench                                  [Usage] [Chat] [Project v]   |
+---------------+------------------------------------------------------------+
| Workspace     | Workspace / Usage                                          |
| Projects      | Model usage                         Updated 10:42 [Refresh]|
| ...           | Last 30 days v   Daily v   UTC v                [Export CSV]|
|               | Project: All v   Activity: All v   Model: All v             |
|               |                                                            |
|               | 1,284,600 tokens                                           |
|               | 842 requests / 74 operations / 3 models                     |
|               | 831 complete counts / 8 partial / 3 unavailable             |
|               |                                                            |
|               |        ||       |             |||                          |
|               |   |  ||||   |  |||      |   ||||||    |                    |
|               | __|__||||___|__|||______|___||||||____|________________    |
|               | Input / Cached input / Output        [Show data table]     |
|               |                                                            |
|               | [Projects] [Activities] [Models] [Operations]              |
|               | Project              Input      Output    Tokens Requests |
|               | Atlas              240,000      31,000   271,000      180  |
|               | Workspace / shared  85,000      12,000    97,000       24  |
|               | ...                                                        |
+---------------+------------------------------------------------------------+
```

The figures above illustrate layout only. Implement these interactions:

- Default to **Last 30 days / Daily**, all projects, activities, and models. Show the workspace reporting timezone explicitly; initialize it from the workspace review timezone, otherwise UTC. A report-only timezone override must not change review scheduling.
- Display total known tokens as the headline. If accounting is incomplete, label it **Known tokens** and show complete/partial/unavailable request counts next to it. Show input, output, and cache details below, not four competing headline cards.
- Offer **Tokens** and **Requests** chart metrics. Tokens stack normalized input/cache/output components; Requests stacks activity categories. The Models table supplies model-by-model totals, and selecting a model filters the timeline. Do not generate dozens of colored model series.
- Filters combine with AND. Allow one project, activity, provider/model pair, and operation at a time; **All reviews** selects both project review and workspace review. Show active filters as removable chips and provide **Clear filters**.
- Clicking a bucket narrows the detail tables to that bucket without silently changing the main range. Show a removable bucket chip. Clicking a project, model, or activity row applies that filter. Every action has a keyboard equivalent.
- The Projects table includes a **Workspace / shared** row and a **Legacy / unattributed** row when applicable. Do not distribute synthesis tokens across projects.
- The Activities table separates chat, project review, workspace review, progress-report drafts, and system/other inference. An expandable subtask breakdown exposes compaction and retries without adding their tokens twice.
- The Operations table groups physical requests under a chat turn or review run, with start time, trigger, project, models, known tokens, request count, outcome, and coverage. Expand a row for request-level metadata and retry lineage. Do not fetch or display conversation text.
- Sort tables by tokens descending initially; expose sortable numeric/date columns and server-side pagination. Show exact integers in tables/tooltips; compact headline numbers may round only for display.
- Poll every 15 seconds while visible, pause when hidden, and offer **Refresh**. A single refresh uses one consistent snapshot for headline, chart, and table. Never move focus or reset filters on refresh.
- Preserve filters and the active breakdown in query parameters so reload, copied links, and browser navigation reproduce the view. Use opaque operation IDs, not filesystem paths. A project switch while reporting is open must not silently change filters.
- CSV export downloads the currently displayed breakdown with all matching rows, not only the current page. Include range, timezone, filters, coverage, and exact counts; exclude raw content. Escape CSV fields and neutralize spreadsheet-formula prefixes in labels.

### Handle all presentation states

| State | Required presentation |
| :--- | :--- |
| Newly enabled | “Usage tracking started at [timestamp]. Earlier usage is unavailable.” No fabricated history. |
| No requests in a covered range | Flat zero chart and “No model requests in this period.” |
| No filter matches | “No usage matches these filters” with **Clear filters**. |
| Requests without counts | Request totals remain visible; tokens show **Unavailable**, not zero. |
| Partially covered range | Annotate pre-installation time and accounting gaps, distinct from known zero activity. |
| Running request | Include in-flight request count; do not animate invented live token estimates. |
| API or ledger error | Retain last successful snapshot with **Out of date** and **Retry**; never replace it with zeros. |
| Deleted project/model | Retain historical identity and counts, with **No longer available** where known. |

At 360 px, stack controls and summary, keep the chart within the viewport, and put wide tables in labeled scroll regions. Provide semantic tables, visible focus, accessible filter labels, a textual chart summary, and an equivalent bucket data table. Meet WCAG AA contrast, honor reduced motion, and use polite status announcements only for user-triggered refresh/error changes.

## Capture usage at the inference boundary

### Ground the changes in existing code

| Current surface | Required integration |
| :--- | :--- |
| `src/server.js`: `providerStream()` | Pass immutable attribution to Pi and instrument the direct Anthropic/OpenAI/compatible adapters. Consume provider usage events rather than only text deltas. |
| `src/pi-harness.mjs`: `runPiTurn()` | Capture every physical inference, tool continuation, retry, and automatic compaction request. Session-level text/status events alone are insufficient. |
| `src/pi-harness.mjs`: `runPiReview()` and `src/review-submission.mjs` | Capture usage before response validation can throw. Cover both JSON-text and result-tool transports and preserve the one-request-per-submission rule. |
| `src/workspace-review-pipeline.js` | Attach review-run ID, project ID, stage, trigger, attempt lineage, and actual model selection to each provider invocation. Record validation rejection separately from transport outcome. |
| `src/workspace-review.js`: progress reports | Attribute the existing text-contract report call to its project and `progress_report`, not ordinary chat. |
| `src/workspace-review-store.js` | Reuse workspace-key conventions, but keep usage retention independent from review history, cache, and trace cleanup. |
| `src/public/app.js`, `app.css`, `index.html` | Add the application route, global entry point, report rendering, contextual links, and responsive styles. |

Introduce small modules such as `src/usage-store.js`, `src/usage-normalization.js`, and `src/usage-reporting.js`. Keep provider interpretation separate from storage and pure aggregation. Do not put the ledger in conversation history or use existing `usage.updated` status messages as the accounting source.

```text
Chat / review / report coordinator
        | immutable operation + attribution context
        v
Pi physical inference hooks OR direct provider adapter
        | start / usage snapshot / finish (one request identity)
        v
Usage normalizer --> durable workspace ledger --> snapshot aggregator
                                                      |
                                                      v
                                               read-only HTTP API
                                                      |
                                                      v
                                               /usage/ + CSV
```

### Distinguish operations, requests, and retries

An **operation** is one accepted user chat turn, review run, progress-report draft, or independently initiated system action. A **request** is one dispatched inference attempt. One chat operation may contain many requests. One review operation may contain project requests, retries, and synthesis requests using different models.

Persist an operation when the server accepts the action, even if it makes no model request. For steering prompts accepted during a running turn, persist an opaque prompt-submission ID and acceptance timestamp under the existing operation; do not invent another inference request. Requests retain the operation's original project scope even if the user navigates elsewhere. Queued turns capture their scope at acceptance.

Create a request ID immediately before each physical dispatch, after local validation. A transport retry that sends another inference request gets a new ID and `retryOfRequestId`; repeated events from the same request do not. A provider failure before dispatch produces an operation failure with zero requests. OAuth/catalog calls do not increment request counts. Cached project assessments cause no new request and no new tokens; retain their reuse outcome on the review operation only.

If the runtime hides retries or compaction from existing hooks, add a supported adapter/interceptor before shipping accounting for that path. Do not silently claim complete accounting at the outer turn boundary. Verify hook behavior against the installed runtime with fake transport tests, including physical model routing. Do not fork dependencies or remove working retry behavior merely to simplify instrumentation; stop and report an explicit blocker if no supported interception path exists.

### Apply deterministic attribution

| Activity | Project attribution | Operation |
| :--- | :--- | :--- |
| `chat` | Selected project, or null for explicit workspace chat | Accepted chat turn |
| `project_review` | Assessed project, including when invoked by a workspace run | Review run |
| `workspace_review` | Null; shared synthesis | Same review run |
| `progress_report` | Reported project | Progress-report draft |
| `system` | Initiating project if genuinely scoped; otherwise null | System operation |

Use a separate `subtask` (`generation`, `tool_continuation`, `compaction`, or `other`) and `trigger` (`user`, `automatic`, or `system`). Compaction inherits its parent activity and project; it is not a second top-level activity total. Review corrections and transport fallbacks retain stage/project attribution. Never infer attribution by parsing prompt text, response text, or a workspace-root argument used only for capabilities.

Review-run detail shows project assessments and shared synthesis separately. A project-filtered report includes its chat, assessments, progress reports, and inherited subtasks, but excludes shared synthesis. Under filters, operation totals mean matching requests only; label them **Filtered usage**. Workspace totals equal the sum of all project rows plus shared and unattributed rows.

## Persist a durable ledger

Use a versioned append-only JSONL journal in `<stateDir>/usage/<workspaceKey>/`, with monthly UTC segments and restrictive permissions (directory `0700`, files `0600` where supported). This avoids a new database dependency and follows the application's local-file storage model. Rebuildable indexes and aggregation caches may improve reads; the journal remains authoritative.

Keep normalized request state as the reduction of idempotent lifecycle events. Each event has a unique ID, schema version, monotonically ordered journal sequence, request/operation ID, and event timestamp. Store start, usage checkpoint, terminal outcome, and bounded validation-outcome updates. Never sum repeated cumulative usage snapshots.

### Request record

| Field | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `schemaVersion`, `requestId`, `operationId` | Integer, opaque strings | Yes | Stable identities; never reuse across retry attempts. |
| `workspaceKey`, `projectId` | String, string or null | Yes | Server-derived scope; null means workspace/shared, not unknown. |
| `attributionStatus` | Enum | Yes | `known` or `unattributed`; reserve the latter for imported/legacy data, not new call sites. |
| `projectLabel` | Bounded string or null | Yes | Historical display snapshot; no absolute path. |
| `activity`, `subtask`, `trigger` | Enums | Yes | Values defined above. |
| `requestedProvider`, `requestedModel` | Strings | Yes | Selection at operation/request creation. |
| `provider`, `model` | Strings or null | Yes | Actual physical identity when known; never rewrite with current settings. |
| `modelIdentitySource` | Enum | Yes | `runtime`, `provider`, `requested_only`, or `unknown`. |
| `startedAt`, `completedAt` | UTC timestamp, timestamp or null | Yes | Start determines time attribution; completion determines duration. |
| `status` | Enum | Yes | `in_flight`, `completed`, `failed`, `aborted`, or `interrupted`. |
| `retryOfRequestId`, `attempt` | String or null, integer | Yes | Retry linkage; first attempt is 1. |
| `validationOutcome` | Enum | Yes | `not_applicable`, `pending`, `accepted`, or `rejected`; rejection does not erase usage. |
| `inputUncached`, `cacheRead`, `cacheWrite`, `output` | Nonnegative integer or null | Yes | Disjoint normalized token components. |
| `reasoning` | Nonnegative integer or null | Yes | Optional output subset; never add it again. |
| `totalTokens` | Nonnegative integer or null | Yes | Authoritative provider total or complete normalized sum. |
| `usageCoverage` | Enum | Yes | `complete`, `partial`, or `unavailable`. |
| `usageSource`, `normalizerVersion` | Enum, integer | Yes | `provider`, `runtime`, or `unavailable`; identifies mapping semantics. |
| `errorCode` | Allowlisted string or null | Yes | Safe machine-readable category, not provider prose. |

The operation record contains ID, workspace/project scope, activity, trigger, start/end, status, accepted prompt-submission metadata where applicable, and review stage/reuse summaries. Derive its token totals from requests; never store a second billable total. Allow operation-level metadata to describe multiple activities in a review run.

### Normalize provider counts

Use integer arithmetic and reject negative, non-finite, or unsafe integers. Preserve missing values as null. Do not infer unknown counts from text length, bytes, max-token limits, or SDK zero defaults.

For a fully known request:

```text
inputTokens = inputUncached + cacheRead + cacheWrite
totalTokens = inputTokens + output
reasoning <= output                 # subset, when supplied
```

- For OpenAI-style inclusive prompt counts, subtract reported cached input from prompt tokens to derive uncached input; cached input is not added twice. For reasoning included in completion tokens, retain reasoning as a subset.
- For Anthropic-style separate input/cache-read/cache-creation counts, add the disjoint components once. Check the actual adapter contract rather than assuming every provider uses these semantics.
- For Pi usage, document and test whether each field is inclusive or disjoint for the installed version. SDK-populated zeros are not proof that a provider reported usage.
- For a provider that reports only total tokens, preserve that total with partial component coverage. The chart renders an explicit **Unclassified tokens** segment so its sum still matches the headline.
- For partially known components without a total, expose the known lower-bound sum and mark partial. If inclusive fields cannot be safely separated, count the inclusive quantity once as unclassified rather than guessing a split.
- For missing optional fields whose protocol explicitly means zero, normalize to zero; otherwise keep null. Document each adapter's rules with fixtures.
- For cumulative streaming events, replace the previous snapshot. For genuinely incremental events, accumulate only documented deltas. Terminal snapshots supersede earlier snapshots for the same request.
- For direct OpenAI-compatible streams, request terminal usage where supported. If a provider rejects that option, any fallback is a separately recorded attempt; never silently discard it. Unsupported usage remains unavailable.
- For failures and aborts, preserve usage already received. An aborted stream with no terminal count remains partial or unavailable, never a fabricated zero.

Provider-reported totals that disagree with normalized components require a diagnostic coverage flag, not silent arithmetic repair. Use the authoritative total for headline aggregation and classify unmatched tokens; test that no negative chart segment or double counting occurs.

### Enforce storage and recovery behavior

- Serialize appends, support cross-process locking when two servers share the state location, and write complete bounded events. Flush request-start records before dispatch and terminal records before declaring accounting settled.
- If the initial durable write fails, do not dispatch a new model request: return `USAGE_STORE_UNAVAILABLE`. Existing requests may finish; retry their bounded in-memory terminal writes and show degraded accounting immediately. Do not claim crash-proof recovery of usage never persisted or reported by a provider.
- On startup, recover orphaned requests as `interrupted` with their last known counts. Do not mark another live process's requests interrupted; use writer identity and liveness/lease checks.
- Ignore duplicate event IDs and repeated terminal delivery. Quarantine a truncated final line; for other corruption, surface a gap/error rather than silently dropping records. Preserve corrupt files for diagnosis.
- Record `trackingStartedAt` and accounting-gap metadata. Read endpoints expose these so pre-tracking periods are not confused with zeros.
- Retain usage indefinitely in v1, including at least a full year of detail. Do not apply review trace expiry, conversation deletion, project exclusion, or activity-tracking preferences to this ledger. Document the disk-growth tradeoff and the local storage path.
- Do not backfill from token guesses or historical conversation lengths. A later exact import requires provenance and deduplication and is out of scope.
- Keep usage state out of workspace evidence, model tools, Git, static file serving, and model context even when a custom state directory is inside the workspace. Extend existing evidence exclusions beyond the review-specific subtree as needed.

## Define time and aggregation semantics

Store instants in UTC and attribute a request's entire usage to `startedAt`. A request crossing a bucket boundary stays in its start bucket; a later terminal update revises that bucket. Do not spread tokens over elapsed time.

Use half-open intervals `[from, to)`, with one server-captured `asOf` instant per response. All totals, charts, and breakdowns share the same filters and snapshot revision.

| Preset | Effective interval | Default bucket |
| :--- | :--- | :--- |
| Last 24 hours | Exactly `asOf - 24 elapsed hours` to `asOf` | Hour |
| Last 30 days | Local midnight 29 calendar dates before today to `asOf` | Day |
| Last year | Same local date/time one calendar year earlier to `asOf`; clamp Feb 29 to Feb 28 | ISO week, starting Monday |
| Last 12 months | First day of the month 11 months before this month to `asOf` | Month |
| Custom | Explicit start/end instants, or selected inclusive local dates converted to midnight boundaries | User-selected hour/day/week/month |

Buckets align to the selected timezone's calendar boundaries and clip to the interval. Mark clipped first/last buckets **Partial period**. Consequently the rolling 24-hour view may contain 25 clipped hourly buckets, and a year may span 53 or 54 clipped ISO-week buckets; do not force a fixed bar count by dropping data. Daily buckets can last 23 or 25 hours at DST transitions. Repeated local hours have distinct UTC start/end keys and visible offsets; nonexistent local hours are not invented. ISO week labels include the ISO week-year.

Return zero-filled buckets only inside known tracking coverage. Include coverage metadata for each bucket and range. Changing timezone may change bucket allocation but must not change totals for the same explicit instant range. Reject ranges over five calendar years or more than 2,000 buckets with an actionable validation error; do not silently coarsen requested granularity.

Group model usage by physical `(provider, model)` identity, falling back to an explicitly labeled requested identity when unresolved. Include request count, distinct operation count, known input/output/cache/total tokens, and coverage counts in every group. Distinct operations are not additive across groups when an operation uses several models or activities; label this and never sum group operation counts into the headline.

## Expose read-only reporting APIs

Add these routes under the existing authenticated/origin-protected API boundary. Bind workspace scope on the server; never accept a filesystem path or arbitrary workspace key from the browser.

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/usage/report` | Snapshot totals, zero-filled buckets, coverage, filter options, and one paginated breakdown. |
| `GET /api/usage/operations/:id` | Operation metadata and paginated request details, restricted to this workspace. |
| `GET /api/usage/export` | Streaming CSV for the same range, filters, snapshot, and breakdown. |

| Query field | Type | Required | Contract |
| :--- | :--- | :--- | :--- |
| `preset` or `from` + `to` | Enum or ISO instants | Yes | Mutually exclusive; presets listed above. |
| `bucket` | `hour/day/week/month` | Yes | Validated against range limits. |
| `timezone` | IANA zone | Yes | Reject unknown zones. |
| `project` | Project ID or reserved shared/unattributed selector | No | Historical IDs remain queryable; no filesystem lookup required. |
| `activity` | Activity enum or `all_reviews` | No | Exact server-side mapping. |
| `provider`, `model` | Bounded strings | No | Model requires provider; match stored identity. |
| `operationId` | Opaque ID | No | Resolve only within current workspace. |
| `breakdown` | `projects/activities/models/operations` | No | Default `projects`. |
| `sort`, `direction` | Allowlisted column, `asc/desc` | No | Stable ID tie-breaker. |
| `cursor`, `limit` | Opaque cursor, integer | No | Default 50, maximum 200 rows. |
| `snapshot` | Opaque revision | No | Reuse for pagination/export; expired snapshots return an explicit error. |

Return `schemaVersion`, `snapshot`, `asOf`, effective range, timezone, filters, tracking/health metadata, totals, buckets, breakdown rows, and `nextCursor`. Use identical metric/coverage object shapes at each level. Bind cursors to filters and snapshot; enforce a 10-minute snapshot lifetime. Exports must not silently mix revisions as usage arrives.

Example request:

```http
GET /api/usage/report?preset=last_30_days&bucket=day&timezone=UTC&activity=all_reviews&breakdown=projects
```

Define preset wire values as `last_24_hours`, `last_30_days`, `last_year`, and `last_12_months`. Reject unknown fields/enums rather than ignoring misspellings. Escape all labels in HTML; treat model/project IDs as untrusted display strings. Set private/no-store response caching and do not expose credentials, absolute paths, or raw provider payloads.

### Error handling

| Error code | HTTP status | Cause and action |
| :--- | :--- | :--- |
| `INVALID_USAGE_QUERY` | 400 | Invalid filter, zone, range, or bucket count. Return a safe field-specific message. |
| `USAGE_NOT_FOUND` | 404 | Operation is absent or belongs to another workspace. Do not distinguish these cases. |
| `USAGE_SNAPSHOT_EXPIRED` | 409 | Refresh the report before paginating or exporting. |
| `USAGE_STORE_UNAVAILABLE` | 503 | Show accounting degradation; block new inference dispatch until durable logging works. |
| `USAGE_LEDGER_CORRUPT` | 503 | Preserve last good view and diagnostics; do not present incomplete totals as complete. |

## Implement in verifiable stages

1. Inventory every inference entry point and inspect runtime hooks. Add a call-path coverage test/table, including retries, compaction, compatible providers, and structured/text review paths. Resolve interception blockers before UI work.
2. Implement the schema, durable journal, locking, recovery, and pure provider normalization with deterministic fixtures and an injected clock.
3. Propagate immutable operation context and instrument physical requests. Verify request counts against fake transport dispatches. Persist usage before any review validation failure discards the result.
4. Implement pure aggregation, timezone bucketing, snapshot pagination, CSV export, and protected HTTP routes. Add indexes incrementally without changing source-of-truth semantics.
5. Implement `/usage/`, navigation, contextual links, responsive charts/tables, and all empty/error states using existing design tokens.
6. Run unit, HTTP, and browser tests; perform keyboard and mobile checks; update user-facing help with storage location, accounting limitations, retention, and recovery behavior. Ship tracking and reporting together without retroactive estimates.

For performance, use a seeded 100,000-request, one-year fixture across 100 projects and 20 models. On a documented development machine, target warm report p95 below 500 ms, cold report below 2 seconds, and additional dispatch logging p95 below 50 ms on local storage. Record benchmark evidence. Keep browser payloads bounded by bucket and pagination limits; stream exports and avoid re-reading the entire journal on every poll. Reporting itself incurs no model cost and adds only local disk/CPU overhead.

## Acceptance criteria

Use fake providers and an injected clock for deterministic tests. Accept the implementation only when the following evidence exists.

| ID | Scenario | Required result and verification |
| :--- | :--- | :--- |
| AC-01 | Chat invokes two tool continuations | Three physical requests, one operation, original project attribution, exact sum of three usage records; harness integration test. |
| AC-02 | User submits, queues, steers, and switches projects | Accepted prompt metadata persists without prompt text; steering stays under its turn; queued/original scope never changes with navigation; HTTP/browser tests. |
| AC-03 | Workspace review assesses two projects then synthesizes | Three requests under one run; two project rows and one shared synthesis row; filtered project total excludes synthesis. |
| AC-04 | Review uses a hybrid model and retries a rejected assessment | Actual models and retry lineage appear separately; rejected output still counts; no requested-model substitution. |
| AC-05 | Review reuses a cached assessment | No new request or tokens for reuse; the run records reuse metadata. An all-cached/no-inference run remains a zero-request operation. |
| AC-06 | Progress-report draft uses its existing text path | Usage belongs to `progress_report` and the selected project, never chat or shared synthesis. |
| AC-07 | Pi compaction, SDK transport retry, fallback, local model, subscription model, and direct adapters | Transport spies match ledger request counts and physical identities in each path; the ledger counts compaction once under inherited scope. No path silently bypasses accounting. |
| AC-08 | Duplicate terminal events and cumulative usage frames | Replaying events leaves totals unchanged; a repeated cumulative count is not added. Separate retry attempts remain separate. |
| AC-09 | Cache and reasoning normalization | Fixture A: inclusive input 1,000, cached 400, output 200 including reasoning 50 yields total 1,200. Fixture B: uncached 600, cache-read 400, cache-write 100, output 200 yields 1,300. No cache/reasoning double count. |
| AC-10 | Provider omits usage, sends partial usage, total-only usage, or contradictory totals | Requests remain visible with correct coverage; null never becomes invented zero; known totals reconcile with chart including unclassified tokens; adapter unit tests. |
| AC-11 | Abort, timeout, invalid JSON, output limit, unsupported result tool, and provider error | Every dispatched attempt remains in the ledger with safe outcome and available counts. Validation failure never loses usage. Pre-dispatch rejection has zero requests. |
| AC-12 | Restart during a request and replay journal | Prior completed usage survives; orphan becomes interrupted; partial counts survive; no duplicate totals or interruption of live writers. |
| AC-13 | Concurrent servers, disk failure, and truncated journal tail | Locks prevent interleaved records; failed start persistence prevents dispatch; terminal-write failures show degraded accounting; recoverable tail does not destroy prior records. Other corruption is explicit. |
| AC-14 | Reporting range boundaries | Requests at `from` count and requests exactly at `to` do not. All required presets, partial first/last buckets, leap day, ISO week-year, DST spring-forward/fall-back, and cross-bucket requests pass fixed-clock tests. |
| AC-15 | Aggregation consistency | For identical filters/snapshot, headline tokens equal bucket sum and each complete project/activity/model breakdown sum. The aggregator deduplicates distinct operation counts independently. |
| AC-16 | Filtering and pagination | Combined project/activity/model/run filters work; pagination and export share the snapshot; stale snapshots return 409; historical projects/models remain selectable. |
| AC-17 | Retention and historical identity | Restart, conversation deletion, review trace expiry, project exclusion/deletion, and model removal do not erase recorded usage. No false backfill appears before tracking start. |
| AC-18 | Security and privacy | The application safely handles hostile IDs/labels, cross-workspace operation IDs, invalid paths/queries, and spreadsheet formulas. Ledger/API/CSV contain no fixture secret, prompt, response, reasoning, tool payload, or absolute root. Evidence collection and tools exclude custom in-workspace state. |
| AC-19 | Global and contextual navigation | Usage works from workspace and project pages, collapsed sidebar, and direct URL reload. Contextual links apply correct filters. Back restores chat draft/layout and does not cancel active work. |
| AC-20 | Reporting presentation | Hourly/day/week/month views, token/request toggle, all four breakdowns, run drill-down, export, exact tooltips, unknown coverage, no-data, and stale/error states pass browser assertions. |
| AC-21 | Accessibility and responsive layout | Keyboard can navigate filters, chart data alternative, drill-down, and export. At 360 px and desktop widths, controls remain usable with no page-level horizontal overflow. Capture light/dark screenshots and record manual focus/contrast checks. |
| AC-22 | Performance and regressions | Seeded benchmark meets documented targets or has an explicitly approved deviation; existing test/build suites pass; reporting causes zero provider calls and does not alter review limits or agent permissions. |

Suggested new test files: `test/usage-store.test.mjs`, `test/usage-normalization.test.mjs`, `test/usage-reporting.test.mjs`, `test/usage-http.test.mjs`, and `test/e2e/usage.e2e.mjs`. Extend existing harness/review integration tests rather than proving coverage solely with isolated ledger mocks.

Run `npm test`, `npm run test:stress`, and `npm run test:e2e`. Record unavailable environment-dependent checks explicitly; do not substitute a successful build for runtime verification.

## What's next

Use this contract as the implementation handoff to 6.1-terra. This specification fixes the product decisions; the remaining engineering discovery is the installed runtime's physical-request interception surface. If that surface cannot expose a required path, report the exact missing hook and affected acceptance criteria before proceeding with a reduced accounting claim.

Related contracts:

- [Workspace overview](WORKSPACE-OVERVIEW-SPEC.md)
- [Structured review output](WORKSPACE-REVIEW-STRUCTURED-OUTPUT-SPEC.md)
- [Review reliability](WORKSPACE-REVIEW-RELIABILITY.md)
- [Project-scoped context](PROJECT-SCOPED-CONTEXT-SPEC.md)
- [Security model](SECURITY.md)
