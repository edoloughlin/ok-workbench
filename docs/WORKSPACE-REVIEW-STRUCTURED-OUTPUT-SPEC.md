# Make workspace review output reliable

Make workspace reviews usable with login-backed providers by separating model reasoning from output formatting, accepting bounded presentation overruns, and submitting results through a capability-aware structured channel. Keep JSON as the internal contract; do not require an API key or weaken evidence validation.

**Status:** Implemented with deterministic regression coverage and credential-free local HTTP tests through Pi 1.4. The server enables structured submission for supported Pi protocol families, including Copilot's OpenAI completions and Anthropic messages adapters. Live Copilot reliability is **Not evaluated**. Live measurement is optional reliability evidence, not a prerequisite for shipping this implementation. See [Implementation notes](#implementation-notes) for the field inventory and verification boundaries.

This specification extends [cached per-project workspace reviews](WORKSPACE-REVIEW-RELIABILITY.md). It supersedes that document's prohibition on model tools only for result-submission tools, and its output-format, text-length, and correction rules where explicitly stated below. Preserve its collection boundaries, cache isolation, automatic opt-in, call limits, cancellation, evidence rules, and publication guards.

## Before you begin

- Read `src/workspace-review-pipeline.js`, `src/workspace-review-schema.js`, `src/workspace-review.js`, `src/workspace-review-store.js`, `src/server.js`, `src/pi-harness.mjs`, and the overview rendering in `src/public/app.js`.
- Use the existing Node.js server, plain JavaScript frontend, atomic state storage, and Pi runtime. Read the installed Pi SDK documentation before choosing tool registration, turn termination, or request interception APIs. Do not assume an SDK option exists.
- Use deterministic fake providers for CI. For live evaluation, use an explicitly authorized Copilot login and synthetic or approved project evidence. An API key is not a prerequisite.
- Inspect current saved failure traces locally. Do not commit project content, account identifiers, credentials, or raw production traces as fixtures.
- Do not edit `dist/` directly or add a general-purpose JSON repair dependency.

## Establish the implementation contract

### Current behavior

The current pipeline requests free-form streamed text, parses it as JSON, and validates the result. Review turns set `noWorkspaceTools` and register no tools. The parser accepts a complete JSON fence and narrowly recovers trailing closing punctuation; it does not provide schema-constrained generation.

After an `INVALID_REVIEW`, the pipeline makes at most one correction request. For a project assessment with a separate assessment model, the second attempt uses the workspace model with fresh original input. Other corrections include the rejected candidate and validation feedback. The shared text validator accepts up to 120% of a field's nominal limit, then rejects the result. Validation generally stops at the first error.

The pipeline already caches project assessments independently and preserves successful work across synthesis failures. Extend these mechanisms rather than introduce a second review engine.

### Goals and non-goals

| Area | Required outcome |
| :--- | :--- |
| Login-only operation | Complete project assessments and workspace synthesis using a supported Copilot model without an API key. |
| Output handling | Prefer a supported result-submission protocol; retain bounded JSON text fallback. |
| Presentation | Do not reject useful results solely for exceeding a display target within a hard limit. |
| Correctness | Reject invalid evidence ownership, fabricated quotations, unsupported dates, invalid project membership, and unsafe output. |
| Recovery | Correct only the failed stage with precise feedback and no hidden request multiplication. |
| Partial results | Preserve validated assessments and show their timestamps even when synthesis fails. |
| Compatibility | Preserve saved credentials, settings, controls, historical reviews, and normal chat behavior. |
| Non-goals | No Markdown/YAML output protocol, general agent workspace access, unlimited retries, silent model switching, or guarantee that structured output makes judgments correct. |

Authentication type does not establish output capability. Select a transport by provider adapter, model, endpoint, and tested runtime protocol support, not by the presence of an API key.

## Define the architecture

```text
Bounded evidence + stage contract + selected model
                         |
                 Capability resolver
                   /             \
        Result-only tool       JSON text fallback
                   \             /
                    Candidate boundary
                           |
              Structural validation + issues
                           |
               Evidence/semantic validation
                           |
               Canonical server assembly
                    /               \
             Valid result         Rejected stage
                  |                    |
          Publication guard     One reserved recovery
                  |              attempt, or stop
         Project cache / synthesis
                  |
      Current result or explicit partial/stale view
```

| Component | Responsibility |
| :--- | :--- |
| Output contract module | Define model-facing schemas, display targets, hard limits, issue codes, and canonical conversion. A new focused module is acceptable. |
| Capability resolver | Choose a supported transport and explain unsupported or fallback modes. |
| Provider adapter | Return a candidate envelope and attempt metadata instead of relying exclusively on concatenated text. |
| Review harness | Expose only the stage's submission tool, capture its arguments, and stop without a follow-up assistant request. |
| Validator | Collect bounded errors and distinguish presentation warnings from correctness failures. |
| Coordinator | Own every provider dispatch, correction allowance, budget reservation, abort, and publication decision. |
| Store and UI | Preserve validated results and display stage-specific freshness and safe errors. |

Keep transport, canonical validation, and persistence separate. Both transports feed the same validator and produce the same canonical result. Keep transient candidates in memory; restart from committed caches rather than attempting to resume an incomplete model turn.

## Implement capability-aware submission

### Select the transport

Add an internal capability record keyed by provider adapter, endpoint family, model ID, and runtime version. Track `resultTool` as `supported`, `verified`, `unsupported`, or `unknown`, with its support or verification source. `supported` identifies a runtime protocol with an implementation and passing local tests; it does not claim measured model reliability. An optional exact verification record can record stronger model-specific evidence. Do not persist credentials or infer support from a model label.

- For a supported Pi 1.4 protocol or an explicitly verified model/adapter pair, use `result_tool`. Supported protocols are `openai-completions`, `anthropic-messages`, `openai-responses`, and `openai-codex-responses`. Unknown runtime families stay on text until tested.
- For unknown or unsupported pairs, use `json_text`. Do not make a paid capability probe when opening settings or reading review state.
- If a tool transport receives an explicit unsupported-tool response, mark that combination unsupported for the current process and permit text fallback only within the existing recovery allowance.
- Do not downgrade capability after an ordinary schema failure or missing submission. Those failures do not prove lack of tool support.
- Do not switch provider, model, effort, or credentials merely to obtain tool support. Preserve the configured project-to-workspace-model recovery policy.
- Keep native provider schema-constrained response support outside the initial implementation. Leave an adapter seam for it; advertise it only after you verify the actual endpoint.

Expose the effective mode as read-only help in **Settings > Monitoring**. Use **Structured submission** or **JSON text fallback** with a short explanation. Do not equate this label with reasoning quality or evidence correctness.

### Restrict the result tools

Register exactly one tool for the active stage:

| Tool | Input | Effect |
| :--- | :--- | :--- |
| `submit_project_assessment` | Project model-output schema | Capture one candidate for the current project. |
| `submit_workspace_overview` | Workspace model-output schema | Capture one candidate for the current synthesis. |

The tools have no filesystem, network, shell, secret, or project mutation capability. Keep `noWorkspaceTools` protections intact; introduce a separate output-tool option rather than enabling the normal chat tool list. Do not start a file-tool worker for a review.

Enforce these invariants:

- Treat all tool arguments as untrusted model output. A successful tool call does not imply a valid review.
- Accept exactly one expected submission per provider response. Reject unexpected names, duplicate submissions, and incomplete argument streams. Do not use a first-wins or last-wins policy.
- If the response also contains commentary, ignore it as result data. Include its bytes in the total response guard; never parse it as a second candidate.
- Validate only after the provider response completes without truncation or transport failure. Do not publish an early tool callback while later events can contradict it.
- Stop after capturing the response. Do not let the harness send an automatic tool-result continuation or generate a final prose answer.
- If the SDK cannot guarantee these boundaries, keep that adapter on text fallback and report the structured-mode implementation gap.

The coordinator can send validation feedback in a separate, explicitly reserved correction request. This preserves tool-based submission without an unbounded agent loop.

### Define the adapter envelope

Use a discriminated internal result rather than overloading the existing chat delta callback. Normal chat and progress-report behavior remain unchanged.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `transport` | Enum | Yes | `result_tool` or `json_text`. |
| `candidate` | JSON value | Tool mode | Captured complete arguments; not yet validated. |
| `text` | String | Text mode | Bounded assistant text for the existing strict parser. |
| `finishReason` | Normalized enum | Yes | Complete, output limit, aborted, or failed. |
| `responseBytes` | Integer | Yes | Aggregate UTF-8 response size, including tool arguments and discarded commentary. |
| `requestCount` | Integer | Yes | Actual upstream model requests; must be one per coordinator dispatch. |
| `outputLimitEnforced` | Boolean | Yes | Whether the adapter enforced the requested output-token bound. |

Use an internal implementation version to evolve this envelope. Do not expose raw candidates through public status endpoints.

## Simplify the model-facing contract

Keep canonical persisted review objects compatible with the existing UI. Add a versioned model-facing contract and convert it to canonical data only after structural checks.

- Preserve the current `ProjectResult` shape for the first iteration, including explicit project identity and evidence references. Existing server-generated issue IDs, evidence signatures, timestamps, and digests remain server-owned.
- Replace synthesis `priorities[].rank` with array order. Each entry contains only `projectId`, `priority`, and `priorityReason`; entry position defines rank `index + 1`.
- Require exactly one priority entry per selected project. Reject duplicate, missing, or unknown IDs instead of silently sorting or filling gaps.
- Reject model-supplied `rank` in the new model-facing contract. The canonical converter adds it before existing assembled-review validation.
- Reuse validated project assessments in synthesis assembly. Do not allow synthesis to replace their trajectory, lifecycle, outcome, confidence, or source claims.
- Preserve explicit empty arrays and nullable fields in the initial version. Do not silently remove rejected optional claims or treat missing required fields as empty.
- Keep existing maximum item counts, selected-project limits, citation requirements, and stale-evidence restrictions.

Generate tool schema constraints and text-mode contract instructions from shared definitions. Include JSON-compatible types, required fields, enums, bounded arrays, and `additionalProperties: false` where supported. Because providers may ignore schema keywords, repeat all constraints in local validation.

### Separate display targets from hard limits

Replace the global 120% rule with explicit field metadata. Do not globally loosen `plain()` and accidentally relax identifiers, quotes, or other features that share it.

| Field category | Display target | Hard acceptance limit | Handling |
| :--- | :--- | :--- | :--- |
| Narrative display fields | Existing nominal target | `min(4 * target, 4096)` Unicode code points | Accept within hard limit; attach a presentation warning above target. |
| Identity and evidence fields | Not a display concern | Existing strict validation | Never shorten, substitute, or coerce. |
| Quotations and date evidence | Existing contract | Existing strict limit and exact-match rules | Never trim a quote to manufacture a match. |
| Concrete actions, including `firstStep` and project next-action fields | Existing contract | Existing accepted bound and semantic checks | Preserve single-action rules; correct rather than truncate. |
| Enums, dates, ranks, and collection sizes | Not a display concern | Existing strict rules, except server-derived ranks | Reject invalid values. |

Before implementation, create a field-path inventory from the current validators. The narrative allowlist covers headlines, summaries, project outcome/assessment/blocker prose, priority reasons, attention explanatory prose, change explanations, and question text/reasons/options. Fields outside that explicit inventory retain their existing rules. If a field combines an action or quotation with prose, classify it as strict.

Trim surrounding whitespace only where the current contract permits it. Do not silently truncate stored text, alter quoted content, or normalize an invalid enum into a valid one. Keep the current rejection of disallowed control characters.

Render accepted long prose as escaped text. Clamp previews where needed and provide an accessible **Show more / Show less** control without additional model calls. Preserve the full accepted text for expanded views and copy/export behavior. A presentation warning does not make an assessment stale or partial.

Keep project responses at 16 KiB and synthesis responses at 64 KiB, including tool arguments. Field limits do not override aggregate limits. Preserve current input budgets and the current stage-specific output-token settings; do not increase token limits as a substitute for smaller contracts.

## Validate and recover within a fixed budget

### Return structured validation issues

Validate structure before traversing child values. Collect independent issues up to 20 entries and 8 KiB of serialized feedback. If more exist, set `truncated: true`; do not crash on malformed nested values.

```json
{
  "accepted": false,
  "issues": [
    {
      "path": "/attention/1/evidenceIds/0",
      "code": "UNKNOWN_EVIDENCE_ID",
      "rule": "Use an evidence ID from this stage's supplied evidence."
    }
  ],
  "truncated": false
}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | String | Yes | JSON Pointer to the invalid field; use the root path for parse failures. |
| `code` | Allowlisted string | Yes | Stable machine-readable validation category. |
| `rule` | Bounded string | Yes | Server-authored explanation without rejected model excerpts. |
| `limit` | Integer | No | Applicable hard limit, where useful. |
| `actual` | Integer | No | Observed length or item count, never raw content. |

Keep evidence IDs in the original input instead of repeating arbitrarily large allowed-value lists in errors. Separate presentation warnings from rejection issues. After conversion, run the complete canonical and evidence validators; transport-level schema success never bypasses them.

### Correct a stage, not the portfolio

Allow at most two upstream requests for each project or synthesis invocation: an initial request and one recovery request. Tool feedback, text repair, capability fallback, SDK retries, and a workspace-model fallback all share this allowance; none adds a third request.

- For recoverable parse, submission, structure, or semantic failures, supply original evidence plus bounded structured feedback.
- For same-model correction, include the rejected stage candidate only if it fits the stage input budget. Mark it as untrusted output, not evidence or instructions.
- If the rejected candidate cannot fit, send one fresh stage regeneration with safe issue codes and original input, provided that required input still fits. Never truncate JSON or essential evidence to force a correction.
- For a configured project-to-workspace-model fallback, regenerate only the failed project's result using original evidence and structured issues. Do not require an API-key provider.
- If one field is invalid, replace that stage's object, not other projects or the whole workspace review. Do not implement arbitrary model-authored JSON Patch in this iteration; cross-field invariants still require complete stage validation.
- If the response exceeds its size limit or the request ends in truncation, timeout, cancellation, or transport/authentication failure, preserve existing failure/backoff behavior rather than treating it as a JSON repair opportunity.
- If a complete response is missing a submission, permit one fresh text-mode correction within the same recovery allowance. Do not persist a capability downgrade: a model ignoring a tool does not prove that the endpoint lacks tool support. Unexpected or duplicate calls receive at most one corrective submission request.

Reserve and durably account for every upstream dispatch before it occurs. Preserve the automatic synthesis reservation, rolling daily call limit, job deadline, concurrency, and later target-scoped retry/backoff rules. A later scheduled retry is a new stage invocation under those existing rules, not a hidden continuation.

Keep the 120-second per-request timeout and 30-minute job deadline. Disable internal harness retries and automatic continuations for review output requests. If the runtime makes extra upstream requests that the coordinator cannot intercept and reserve, structured submission cannot ship for that adapter.

## Preserve partial results and truthful freshness

Keep project caches independent of synthesis and retain the last good published overview on synthesis failure.

| Situation | Required UI and storage behavior |
| :--- | :--- |
| Project success, synthesis failure | Commit the project result. Show its successful assessment time separately from the old overview. |
| First review, synthesis failure | Show validated project assessments and **Workspace overview unavailable**. Do not show invented ranks, focus, or a completed overview timestamp. |
| Previous overview exists | Keep its original ID and completion time; label it **Previous overview** and expose the failed refresh separately. |
| Project failure with a prior result | Keep its prior timestamp and source snapshot; label it stale. |
| Project failure without a prior result | Show unavailable/unknown, never a validated placeholder. |
| Retry after synthesis failure | Reuse healthy project caches. Retry synthesis only unless project dependencies changed or became due. |
| Exclusion, deletion, settings change, or cancellation during a call | Recheck dependency guards and redact ineligible data. Never publish late output. |

Use the existing incremental **Review now** operation for retry. The UI can label it **Retry overview** when only synthesis needs work; recompute dependencies server-side instead of promising zero project calls after evidence changes.

Do not splice fresh assessments into old published priorities as if they formed a newly synthesized review. Keep assessment freshness and overview freshness visibly separate.

## Version caches and protect diagnostics

- Version the model-output contract, prompt, canonical conversion, and validator dependencies. Include semantic versions in existing project/synthesis cache keys.
- Preserve legacy published reviews for historical display. Do not reset settings, controls, credentials, activity, or guidance.
- Treat incompatible project caches as misses for new work; preserve compatible historical content for explicitly stale display under the existing policy.
- Keep transport selection out of semantic cache keys when the model, evidence, contract, and canonical semantics are identical. A transport-mode change alone must not refresh every valid assessment.
- Record actual provider/model, transport, recovery reason, contract version, warnings, request count, response size, and duration as bounded provenance.
- Preserve atomic commits, current attempt reservations, and restart behavior.

Persist only allowlisted validation codes, paths, counts, and content-free response shapes in public state. Never return rejected candidates, arbitrary provider errors, tool arguments, or full validator messages through review status.

The current implementation has local failure-trace storage. Route new diagnostics through its existing access, retention, size, and redaction controls; do not introduce a second raw-output log. Do not add production traces to source control. Synthetic regression fixtures must preserve failure shape without retaining private project evidence.

## Handle errors

Map these internal categories to existing public error families where possible. Extend public allowlists deliberately; do not pass arbitrary provider codes through to clients.

| Error category | Cause | Required action |
| :--- | :--- | :--- |
| `OUTPUT_TOOL_UNSUPPORTED` | Adapter explicitly rejects the tool mechanism | One text fallback if recovery budget remains; record capability downgrade. |
| `OUTPUT_SUBMISSION_MISSING` | Complete response contains no expected submission | One corrective stage request if budget permits. |
| `OUTPUT_SUBMISSION_AMBIGUOUS` | Multiple submissions or unexpected tool call | Reject; one correction if budget permits. |
| `OUTPUT_INVALID_JSON` | Text fallback or tool arguments cannot parse | Reject; one correction if budget permits. |
| `OUTPUT_SCHEMA_INVALID` | Invalid type, required field, enum, membership, or hard limit | Return bounded issues; one correction if budget permits. |
| `OUTPUT_EVIDENCE_INVALID` | Invalid quote, date support, source ownership, or stale evidence use | Reject without weakening rules; one correction if budget permits. |
| `FOCUS_NOT_CURRENT` validation issue | `focusProjectId` names a stale or unavailable assessment | Return an issue at `/focusProjectId`; choose an ID from `eligibility.focusProjectIds` or null. Preserve priority overrides. |
| `STALE_EVIDENCE` validation issue | A new synthesis citation, claim, or date uses stale original evidence | Return an issue at each affected reference; use only `eligibility.evidenceIds`. Keep the existing two-request budget. |
| `OUTPUT_TRUNCATED` | Provider reports output limit or incomplete argument stream | Do not accept a parseable prefix or manufacture closing delimiters; preserve partial job progress. |
| Existing timeout, cancellation, authentication, response-size, and budget errors | Non-validation failure | Preserve existing stop/defer/backoff behavior; no extra format-repair request. |

Retain only the current narrow, tested text normalization behavior. Do not extract an object from arbitrary prose, guess missing fields, repair truncated structures, execute model code, or accept invalid evidence because formatting recovery succeeded.

## Implement in verifiable steps

1. Capture sanitized synthetic fixtures for current parse, length, schema, and semantic failures. Establish deterministic baseline behavior and record known unrelated test failures.
2. Introduce shared output definitions, explicit field-policy inventory, structured issues, ordered synthesis priorities, and canonical conversion. Keep text fallback working through the new contract.
3. Implement capability resolution and the result-only harness path. Verify exactly-one-request behavior, complete-response handling, no workspace tools, and abort propagation before enabling any model pair.
4. Integrate candidate envelopes and bounded recovery into the coordinator's existing reservation and retry logic. Do not add a second retry loop in the provider adapter.
5. Add cache versioning, safe provenance, partial-assessment projection, settings mode descriptions, and expandable narrative UI.
6. Extend unit, harness, coordinator, HTTP, fixture, and browser tests. Run the acceptance matrix below, `npm test`, and `npm run test:e2e`.
7. Optionally run an explicitly authorized live evaluation and record model-specific reliability separately. Do not require credentials or a live evaluation to enable a locally tested supported protocol. Keep unknown and explicitly unsupported combinations on bounded text fallback.

### Map implementation work to files

| Location | Change |
| :--- | :--- |
| `src/workspace-review-schema.js` and a focused output-contract module | Explicit field policies, shared schemas, bounded issue collection, canonical rank derivation. |
| `src/workspace-review.js` | Contract-aware prompts, capability metadata integration, safe public state. |
| `src/workspace-review-pipeline.js` | Candidate validation, shared two-request budget, correction input, independent publication. |
| `src/server.js` | Review-specific adapter envelope, dispatch metadata, no changes to ordinary chat streaming contracts. |
| `src/pi-harness.mjs` | Result-only tools, terminal capture, disabled auto-continuation, verified request accounting. |
| `src/workspace-review-store.js` | Compatible provenance and cache-version handling; preserve atomic storage. |
| `src/public/app.js`, `src/public/app.css`, `src/public/index.html` | Output-mode explanation, truthful partial status, bounded previews with accessible expansion. |
| `test/pi-harness.test.mjs` and review unit/HTTP/fixture suites | Transport, validation, accounting, cache, and publication coverage. |
| `test/e2e/workspace-overview.e2e.mjs` | Login-only setup, settings help, long prose, synthesis failure, and retry behavior. |

## Verify acceptance criteria

### Deterministic correctness gate

Use a three-project workspace A/B/C, an injected clock, temporary state, and fake providers with explicit stage/transport dispatch records. Exercise the real coordinator, store, validators, and HTTP projection. Assert upstream request counts, not only tool invocation counts.

| ID | Scenario | Acceptance criteria |
| :--- | :--- | :--- |
| AC-01 | Supported tool provider, login-only configuration | A/B/C submit valid project results and synthesis submits a valid overview. Four upstream calls publish a complete review; the adapter performs no API key lookup. |
| AC-02 | Unknown or unsupported capability | The resolver selects text mode without a probe request. Valid text output passes the same canonical validator. Opening settings and GET state make zero model requests. |
| AC-03 | Explicit unsupported-tool error | At most one fallback request occurs. Two total requests maximum for that stage; subsequent stages use text mode for that pair. Capability does not change after unrelated validation failure. |
| AC-04 | Tool call with commentary | Exactly one complete expected tool submission validates successfully. Commentary does not enter the result and counts toward response size. |
| AC-05 | Missing, unexpected, duplicate, or incomplete tool submission | No candidate publishes. Missing/unexpected/duplicate submission receives at most one correction; incomplete output follows truncation handling. |
| AC-06 | Harness completes a tool callback | No automatic tool-result continuation, final-answer call, workspace tool registration, or file-worker startup occurs. Total upstream dispatch count equals durable attempt accounting. |
| AC-07 | Narrative length boundaries | Test target, target+1, hard limit, and hard limit+1 for every narrative field policy. Within hard limit, preserve full text; above target, warn only; above hard limit, reject. Include non-BMP Unicode and aggregate-byte boundary tests. |
| AC-08 | Strict fields and evidence | Cross-project IDs, fabricated quotes, generated completion evidence, unsupported dates, invalid enums, and vague/chained actions still fail in both transports. No strict field is silently shortened or coerced. |
| AC-09 | Ordered priorities | A valid B/A/C array yields canonical ranks 1/2/3 for B/A/C. Duplicate, missing, unknown IDs and model-supplied rank fail. Synthesis cannot overwrite assessment facts. |
| AC-10 | Multiple validation errors | Return all independently detectable errors up to 20 and 8 KiB, with stable paths/codes. Malformed nested types do not throw an uncaught exception; messages contain no candidate excerpts. |
| AC-11 | Same-model correction succeeds | Only the failed stage reruns. Original evidence and structured feedback appear in the correction input. Full canonical validation succeeds before commit. |
| AC-12 | Separate assessment/workspace models | Recovery uses the configured workspace model with original project input and safe issues, even when both models use login authentication. The coordinator selects no unconfigured fallback model. |
| AC-13 | Repeated invalid result or oversized correction input | Never exceed two requests for the stage. Omit an oversized prior candidate for bounded fresh regeneration; if required input cannot fit, stop without dispatch. |
| AC-14 | Automatic six-call budget and concurrency | Every initial, correction, and capability-fallback call consumes a reservation. Concurrent workers and restart cannot exceed six; recovery cannot steal the synthesis reservation. |
| AC-15 | Transport failure, timeout, truncation, oversized response | No format-repair request occurs. Reject parseable prefixes and partial tool objects; preserve already committed project successes. |
| AC-16 | Project failures with healthy peers | Healthy project caches persist. Failed A retains a timestamped stale result or unavailable state; it does not contribute a new substantive claim. |
| AC-17 | Synthesis fails after successful projects | Existing overview ID/time remain unchanged. New project assessments remain accessible separately. On cold start, show assessments without invented ranks or a completed overview. |
| AC-18 | Retry after synthesis failure | With unchanged, non-due project inputs, retry makes synthesis calls only. If evidence changes first, recompute required work rather than reuse an invalid cache. |
| AC-19 | Restart, version upgrade, and transport change | Settings/credentials/controls survive. Semantic contract changes invalidate appropriate caches; transport change alone does not. Legacy historical reviews remain readable. |
| AC-20 | Cancellation, exclusion, or supersession in flight | Abort reaches the adapter; late tool/text responses cannot commit or publish. Deleted/excluded project data disappears from nested public projections. |
| AC-21 | Long prose UI | Narrow and wide viewports remain usable. Full text is reachable by keyboard and expandable controls expose state. HTML-like model content renders as text. Expansion makes zero provider calls. |
| AC-22 | Diagnostic privacy | HTTP state contains only safe codes, paths, counts, and shapes. Raw candidates, credentials, provider error bodies, and tool arguments do not appear in public errors or telemetry. |
| AC-23 | Normal chat and reports | Existing tools, sign-in flows, chat streaming, and report behavior pass their regression tests; the review-only submission option does not alter them. |
| AC-24 | Text recovery regression | Complete fences and currently supported trailing-punctuation recovery still undergo full validation. Prose-wrapped, truncated, or fabricated repaired data never bypasses validation. |

All deterministic criteria must pass before marking implementation complete. Report skips and known unrelated failures explicitly; do not describe a failing full suite as passing.

### Optional live Copilot reliability evaluation

Run this evaluation separately from CI. Record runtime version, adapter/endpoint identity, model ID, effective effort, output mode, evidence sizes, token caps, timestamps, and the exact fixture revision. Do not include credentials or private evidence in the report.

Use six synthetic portfolios covering healthy-but-quiet, busy-but-drifting, deadlines, parked work, missing evidence, and competing priorities. For each candidate Copilot model, run at least 30 initial project-stage requests and 30 initial synthesis-stage requests, distributed across those portfolios. Permit at most one recovery per stage. Use frozen stage inputs so synthesis comparisons do not change merely because project outputs changed between runs.

Compare the new tool mode against the current text-mode baseline with matched model, effort, evidence, and comparable request budgets. The evaluation is small-sample reliability evidence, not a release prerequisite or a statistical guarantee.

| Metric | Reliability target |
| :--- | :--- |
| First-attempt canonical validation | At least 27/30 valid results in each stage. |
| Valid within the two-request budget | At least 29/30 valid results in each stage. Report validation and transport failures separately; do not exclude inconvenient failures from totals. |
| Evidence safety | Zero accepted results violating fixture evidence ownership, quote, date, or stale-source invariants. Review semantic quality separately from schema validity. |
| Regression against baseline | No lower within-budget success count for either stage. Report first-attempt differences without claiming statistical significance. |
| Cost and latency | Publish median/p95 stage latency, actual requests per accepted result, correction frequency, and available token usage. Every stage remains within request, timeout, byte, and job limits. |
| Honest degradation | Every failed stage leaves the expected stale/unavailable/partial UI and preserves successful cache work. |

If a pair misses a target, publish the observed limitation and consider text fallback for that pair. Do not lower validation standards to make a reliability number pass. If credentials or provider availability prevent evaluation, mark live reliability **Not evaluated**. Supported runtime protocols can still ship with bounded fallback and unchanged validation.

## Roll out and maintain the change

Ship the field-policy and smaller-contract changes with the bounded tool adapter enabled for tested Pi protocols. Keep an internal transport override for tests and rollback; do not add a confusing user-facing protocol selector in the first release. To disable tool selection process-wide, set `OK_WORKBENCH_REVIEW_OUTPUT_MODE=json_text` before starting the server. This override also updates the read-only monitoring description and does not invalidate semantic caches.

Rollback disables tool-mode selection while retaining text fallback, canonical data, settings, and historical reviews. Revalidate capability entries after runtime or endpoint behavior changes. Continue recording stage-level failure categories so formatting failures remain distinguishable from evidence failures and model-quality problems.

The implementation requires no extra hosted service. Local validation and UI expansion make no model calls. Initial and recovery requests consume existing provider usage and automatic budgets; this specification does not promise lower cost or latency before live measurement.

## Implementation notes

### Use the field-policy inventory

`src/workspace-review-output.js` owns the model-facing schemas and explicit narrative allowlist. The following paths use Unicode code-point lengths and `min(4 * target, 4096)` hard limits. Array indexes use `*`; assessment paths also apply to canonical stored project assessments.

| Field path | Display target | Hard limit |
| :--- | :--- | :--- |
| `/headline` | 160 | 640 |
| `/summary` | 600 | 2400 |
| `/assessment/outcome` | 200 | 800 |
| `/assessment/assessment` | 500 | 2000 |
| `/assessment/blocker` | 300 | 1200; nullable |
| `/assessment/cadenceReason` | 200 | 800 |
| `/priorities/*/priorityReason` | 400 | 1600 |
| `/attention/*/title`, `/attentionCandidates/*/title` | 140 | 560 |
| `/attention/*/observation`, `/attentionCandidates/*/observation` | 400 | 1600 |
| `/attention/*/inference`, `/attentionCandidates/*/inference` | 400 | 1600 |
| `/changes/*/text` | 300 | 1200 |
| `/question/text` | 240 | 960 |
| `/question/reason` | 300 | 1200 |
| `/question/options/*` | 100 | 400 |

Keep project/source identity, focus identity, topic, `nextAction`, `action`, `firstStep`, claim excerpts, and date excerpts under their existing strict validators. Preserve enum, date, evidence ownership, lifecycle support, collection-size, and exact-quote checks. `rank` belongs only to canonical server assembly, not model output. Fields outside the explicit allowlist retain their previous rules.

If long accepted prose cannot fit the 8 KiB synthesis pack, omit optional assessment narrative from the model input and disclose the omission in its gaps. Preserve complete text in the project cache, canonical assembly, and UI. Never shorten a required quote or silently exceed the pack limit; surface `INPUT_TOO_LARGE` and retain independent project results instead.

### Verify the runtime boundary

The implementation uses `ModelRuntime.streamSimple()` from Pi 1.4.0, not an `AgentSession`. The installed declarations expose `Context.tools`, `maxTokens`, `reasoning`, `maxRetries`, `timeoutMs`, `signal`, and `onPayload`. A result tool is a declaration with no executable callback. One call consumes one response; the code cannot submit a tool result or run an agent continuation.

`src/review-submission.mjs` captures the final response, rejects ambiguous submissions, counts streamed text/arguments, and aborts the stream on exit. It passes `maxRetries: 0`, requests SSE, clamps the requested output bound, and rejects an unexpected second payload or fetch before dispatch. Result tools disable optional constrained sampling to avoid SDK strict-schema downgrade requests. The adapter rejects redirects rather than silently resending inference requests. Semantic validation and durable budget accounting remain coordinator responsibilities. Ordinary chat and reports keep their existing interfaces.

Capability keys include adapter, provider/endpoint family, exact model, and runtime version. Pi 1.4's four supported protocols default to structured submission without a live verification registry. Exact unsupported responses downgrade only the affected tuple for the process lifetime. The adapter reads bounded, machine-readable unsupported-tool codes and parameter names from HTTP 400/422 bodies; it does not infer capability from arbitrary provider error messages or retain those bodies. Ordinary schema failures never downgrade the tuple.

### Keep priority and freshness separate

The synthesis input includes server-computed `eligibility.focusProjectIds` and `eligibility.evidenceIds`. Both structured feedback and canonical validation use the same eligibility definition. Only current project assessments can supply `focusProjectId`; workspace sources, current project sources, and generated gap facts can supply synthesis citations. Existing ownership, quote, date, and generated-evidence restrictions still apply.

Preserve a user's priority override even when its project assessment becomes stale. A focus priority does not make that assessment current. Keep the project in `priorities` with its override, but use `focusProjectId: null` if no eligible project is an appropriate focus. Never silently promote a different project or remove the user's preference to satisfy validation.

Invalid focus and stale citations produce independent, bounded issues at their JSON Pointer paths, including references in changes, attention, questions, claims, and dates. The public diagnostic is `stale_assessment`, not `schema_mismatch`. Failure traces retain allowlisted issue paths and codes so a budget-exhausted stage remains diagnosable without a correction request. The synthesis prompt version changes independently of project cache dependencies.

Synthetic regression tests reproduce a budget-deferred stale focus override in both transports with one automatic call remaining. They also verify that stale focus/citation feedback can recover with two synthesis requests, preserving healthy project caches, the six-call automatic cap, and the override. No private trace forms part of the committed fixtures.

### Interpret verification results

- `test/workspace-review-output.test.mjs` covers the new schemas, every narrative policy's Unicode boundaries, rank derivation, bounded issues, capability resolution, terminal submissions, correction/fallback accounting, oversized correction input, long synthesis packs, independent cache projection, and non-recoverable failures.
- Existing review fixture/coordinator/HTTP tests cover reuse, restart, reservations, concurrency, cancellation, evidence safety, partial results, and legacy history. Their fake model outputs now use ordered priorities without ranks.
- The prompt-failure evaluator uses the shared production contract. A 244-character outcome now passes production validation but can still fail its separate concision score; presentation quality and correctness are no longer the same gate.
- The browser suite covers safe keyboard-expandable prose, narrow layouts, saved assessments after synthesis failure, output-mode help, and the existing monitoring/settings flows.
- `test/review-submission-http.test.mjs` drives the real installed Pi runtime against local HTTP endpoints for all four supported protocol families. It uses synthetic, unexpired OAuth credentials without API keys or token refresh. Tests verify request schemas, result capture, explicit unsupported-tool errors, text fallback, no hidden SDK retries or continuations, and malformed/truncated stream handling. This proves the local protocol boundary, not live Copilot service behavior or model quality.
- Definition tests use a reproducible synthetic fixture instead of a mutable private file. Browser tooltip assertions wait for asynchronous project lookup completion.
- Live Copilot evaluation is **Not evaluated**. Tests used no production credentials or private project evidence for inference. Optional model-specific measurements can follow without blocking the supported-adapter implementation.

### Verification results

| Check | Result |
| :--- | :--- |
| `OK_WORKBENCH_INTEGRATION=1 npm test` | 181 passed, 2 skipped, 0 failed. Includes 13 real-Pi local HTTP protocol tests. |
| `npm run test:e2e` | 24 passed, 0 skipped, 0 failed. |
| Package smoke | Pack, install into a clean prefix, initialize a workspace, and import the installed harness with hoisted Pi dependencies all passed. |
| `npm audit --omit=dev --audit-level=high` | Passed. DOMPurify lockfile update removes the critical finding; 2 low-severity KaTeX/Mermaid findings remain. |
| Documentation style check and `git diff --check` | Passed. |
| Live Copilot model reliability | Not evaluated; not a shipping prerequisite. |

The unit skips cover the macOS-only Seatbelt worker on Linux and the separately opt-in PyPI wheel-download test (`OK_WORKBENCH_TEST_PYPI=1`). No live provider request forms part of these verification results. Test cleanup retries filesystem removal when detached trace-expiry workers acquire their locks; these retries never dispatch model requests.

## What's next

- Use [WORKSPACE-REVIEW-RELIABILITY.md](WORKSPACE-REVIEW-RELIABILITY.md) for cache scheduling, call accounting, and partial-result invariants not superseded here.
- Use [WORKSPACE-OVERVIEW-SPEC.md](WORKSPACE-OVERVIEW-SPEC.md) for product and evidence requirements.
- Attach the field-policy inventory, deterministic acceptance results, and adapter-support notes to the implementation change. Attach live evaluation results only if an explicitly authorized evaluation is available.
