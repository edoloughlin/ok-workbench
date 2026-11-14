# Implement physical-request lifecycle hooks

This contract adds physical-request accounting hooks to the installed Pi 1.5.0 runtime. It preserves Pi as Workbench’s runtime and preserves provider selection, streaming, compaction, retries, and transport fallbacks.

## Before you begin

- Use Node.js 22.19 or later and the existing test harness.
- Use fake provider transports; automated tests require no credentials.
- Treat the user’s approval of this implementation as a narrow exception to the dependency-fork restriction in `USAGE-REPORTING-SPEC.md`: a reproducible, version-checked temporary dependency patch is permitted for these lifecycle hooks. Do not replace Pi or disable retries.
- Keep the patch source in authored `src/` files. Generate dependency changes through the patch installer; do not hand-edit application `dist/`.

## Implement the approved resolution

1. Add an awaited physical-attempt lifecycle to Pi’s provider request options.
2. Install the lifecycle at HTTP dispatch, Codex WebSocket inference sends, and Google and Bedrock SDK transport boundaries, including internal retries. Do not count authentication, catalog calls, socket handshakes, or tools as inference.
3. Forward the option through simple-stream, chat, review, tool-continuation, and compaction paths.
4. Persist the start before dispatch, cumulative usage checkpoints when available, and a terminal outcome for every dispatched attempt. Preserve unknown counts as unavailable.
5. Verify the installed adapters with fake transport dispatch spies before resuming reporting integration.

### Lifecycle contract

| Field or method | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `onInferenceAttempt` | Async callback | No | Receives safe dispatch metadata and resolves to an attempt observer before dispatch. If absent, retain existing behavior. |
| Dispatch metadata | Object | Yes | Contains provider, model, API, transport, attempt number, and previous request ID when available. Excludes prompts, credentials, endpoints, and tool payloads. |
| `requestId` | Opaque string | No | Observer-provided ID used for retry lineage. |
| `onUsage` | Async callback | No | Receives cumulative usage and its explicit provider/runtime format. Never add repeated snapshots. |
| `onFinish` | Async callback | No | Receives one terminal status: `completed`, `failed`, or `aborted`. Usage remains available after validation rejection. |

The implementation helper exposes `createInferenceObserver(options, model)`, with awaited `start(transport)`, `usage(usage, format)`, `finish(status)`, and `fail(error)` methods. Each physical retry receives a new observer and retains lineage within the logical call. Accounting callback failures must stop dispatch and must bypass retry and fallback handling. SDK instrumentation must run for every physical attempt, not only once around a retrying SDK call.

### Install and maintain the patch

Keep deterministic patch manifests and the shared helper under `src/`. Pin the inspected Pi version, verify source fingerprints before applying changes, accept an already applied patch idempotently, and fail on unknown source rather than silently omitting hooks. Run installation during dependency setup and before build or development startup. Include the installer and patch sources in the published package. Remove the temporary patch after an upstream release provides equivalent tested hooks. Preparing the contribution is local work; publishing it upstream is a separate action.

### Verify acceptance

Fake-transport tests must cover successful dispatch, provider failure, abort, retry, fallback, cumulative usage, and rejected start persistence. Compare physical dispatch counts with lifecycle starts and request IDs. Verify that callback failures produce no subsequent dispatch, that usage survives validation errors, and that no-hook calls preserve runtime behavior. Full usage-reporting acceptance remains governed by AC-01 through AC-22 in the original specification.

## Inspect the original runtime gap

| Call path | Observed interception surface | Status |
| --- | --- | --- |
| Pi agent generation and tool continuations | The session's `agent.streamFunction` sees logical calls, including agent retries. | Insufficient for retries within a provider adapter. |
| Pi automatic compaction | `agent-session.js` passes `agent.streamFunction` into `compact`, including the summarization retry policy. | Logical compaction calls are observable; physical provider attempts still require a lower hook. |
| OpenAI and Anthropic Pi adapters | Their `onPayload` runs before `retryProviderRequest`; the SDK is configured with zero retries, but Pi retries the SDK dispatch itself. Their custom `fetch` option can observe HTTP dispatches. Anthropic can also resend after a strict-tool rejection. | A stream or payload hook alone misses physical attempts. A fetch interceptor needs transport-level tests. |
| Google Generative AI / Vertex | Both adapters reject a custom `fetch`; Generative AI calls `retryGoogleRequest` around the SDK stream request. | No supported per-dispatch interceptor identified. |
| OpenAI Codex subscription | `openai-codex-responses.js` uses WebSocket by default, with internal retry and SSE fallback; only the SSE branch calls the custom `fetch`. | Custom fetch cannot observe every physical attempt. |
| Bedrock | `bedrock-converse-stream.js` constructs `BedrockRuntimeClient` and calls `client.send`; its payload hook precedes dispatch and strict-tool fallback. | No supported per-dispatch interceptor identified. |
| Structured and text Pi review submissions | `collectReviewSubmission` uses a custom fetch and `maxRetries: 0`, and caps requests at one; it validates the response after consuming the stream. | Fetch coverage is adapter-dependent; Google explicitly rejects the custom fetch. Usage must be persisted before validation once a supported boundary exists. |
| Direct and compatible adapters | Workbench owns their request paths in `server.js`. | Independently instrumentable, but not evidence that Pi paths are covered. |

The missing surface is a supported callback or injectable transport immediately before **each physical inference dispatch**, including SDK retries, WebSocket sends and fallbacks, with physical model identity and access to usage and terminal outcomes. A supported runtime adapter providing equivalent coverage would also resolve the blocker. Disabling retries, forcing a different transport, or treating one logical stream as one physical request would change behavior or produce incomplete counts.

Installed-code anchors, relative to `node_modules/@earendil-works/`:

- `pi-ai/dist/types.d.ts:50` defines telemetry for a logical request; lines 53–58 explicitly limit custom fetch to HTTP and allow adapters to reject it. `onPayload` and `onResponse` are defined at lines 69 and 73.
- `pi-ai/dist/api/google-generative-ai.js:36` and `pi-ai/dist/api/google-vertex.js:39` reject custom fetch, before their SDK calls and retry loops.
- `pi-ai/dist/api/openai-codex-responses.js:187` selects WebSocket transport; the send occurs at line 1206, outside the fetch hook. Internal retry and fallback logic starts at line 195.
- `pi-ai/dist/api/bedrock-converse-stream.js:133` constructs the AWS client; the payload callback at line 164 precedes `client.send` at line 169 and cannot intercept SDK retries.
- `pi-ai/dist/telemetry.js:103` observes a logical model request, and starts its span without awaiting it at lines 129–133. Provider registration exposes stream-level adapters (`pi-ai/dist/types.d.ts:198`), not a hook inside the existing adapters' dispatch loops.

Standalone ledger and reporting work remains unintegrated and is not evidence of full implementation or runtime coverage.

Until that surface is available and verified with fake transports, AC-07 cannot be met. The missing dispatch boundary also prevents proving the request and failure accounting required by AC-01, AC-04, AC-08, AC-10, AC-11 and AC-13 across the affected providers. The acceptance matrix requires complete coverage; no reduced accounting claim should be shipped as complete.

## Installed source evidence

These paths are relative to `node_modules/@earendil-works/pi-ai/dist/` in the inspected 1.5.0 installation:

- `types.d.ts:53`: custom fetch does not affect WebSocket transports. `onResponse` runs after an HTTP response, so it cannot durably log a start before dispatch or capture attempts that fail before a response.
- `api/google-generative-ai.js:36` and `api/google-vertex.js:39`: custom fetch is explicitly rejected. Both wrap SDK streaming calls in `retryGoogleRequest`.
- `api/openai-codex-responses.js:187`: the default transport is `auto`; internal WebSocket retry and SSE fallback occur below the logical stream boundary. At line 1206, the adapter sends `response.create` directly through the socket.
- `api/bedrock-converse-stream.js:133`: the adapter constructs its own `BedrockRuntimeClient`; the public options do not expose a pre-dispatch handler for its SDK attempts.

## Current implementation state

`src/usage-store.js` and `src/usage-reporting.js` are standalone drafts, with no server, inference, or UI integration. The ledger lifecycle test and existing normalization tests pass with `node --test test/usage-store.test.mjs test/usage-normalization.test.mjs`. Reporting passes a syntax check only. These checks do not prove the acceptance matrix, durability guarantees, or reporting correctness. Full application, stress, browser, and performance verification remain outstanding.

Resume reporting integration after the approved patch resolves the dispatch gap and fake transport tests prove coverage. The reporting UI and complete accounting claim remain gated on that evidence.

## Troubleshoot accounting failures

| Error | Cause | Action |
| :--- | :--- | :--- |
| Unsupported Pi source or version | Dependency code differs from the inspected patch target. | Stop startup or build and update the patch with transport tests. |
| `USAGE_STORE_UNAVAILABLE` | An accounting callback cannot persist a lifecycle event. | Block further inference dispatch until durable logging works. |
| Missing usage | A provider supplies no usable counts. | Retain the request with unavailable coverage; do not invent zeros. |

## What's next

- Complete [usage reporting](USAGE-REPORTING-SPEC.md) after the runtime-hook tests pass.
