import output from './workspace-review-output.js';

const failure = (message, code, category) => Object.assign(new Error(message), { code, outputCategory: category });
const TOOL_PARAMETERS = new Set(['tools', 'tool_choice', 'functions', 'function_call']);

// Inspect only bounded, machine-readable error metadata. Never infer capability
// from provider prose, retain an error body, or expose it to the browser.
async function toolsUnsupported(response) {
  if (![400, 422].includes(response.status)) return false;
  const copy = response.clone(); const reader = copy.body?.getReader();
  if (!reader) return false;
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 8192) return false;
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const error = body.error || body;
    return ['unsupported_tools', 'tools_not_supported'].includes(error.code) || (['unsupported_parameter', 'unsupported_value'].includes(error.code) && TOOL_PARAMETERS.has(error.param));
  } catch { return false; }
  finally { void reader.cancel().catch(() => {}); }
}

// One low-level model request, not an agent loop. Tools are declarations only:
// there is nothing to execute and no tool-result continuation to schedule.
export async function collectReviewSubmission({ runtime, model, stage, prompt, evidence, transport = 'json_text', maxTokens = stage === 'project' ? 4096 : 16384, effort, signal, timeout = 120_000, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  const checkAbort = () => { if (requestSignal.aborted) throw failure('Review canceled or timed out', signal?.aborted ? 'SUPERSEDED' : 'REVIEW_TIMEOUT'); };
  try {
    checkAbort();
    const limit = stage === 'project' ? 16 * 1024 : 64 * 1024;
    let payloadCount = 0; let requestCount = 0; let observedBytes = 0; let unsupported = false;
    const tool = output.toolDefinition(stage);
    const systemPrompt = transport === 'result_tool' ? `${prompt}\nSubmission channel: call ${tool.name} exactly once with the complete result instead of printing JSON. Do not call any other tool. No follow-up message is needed.` : prompt;
    const stream = runtime.streamSimple(model, { systemPrompt, messages: [{ role: 'user', content: JSON.stringify(evidence), timestamp: Date.now() }], ...(transport === 'result_tool' ? { tools: [tool] } : {}) }, {
      signal: requestSignal, timeoutMs: timeout, maxRetries: 0, maxRetryDelayMs: 1, transport: 'sse', maxTokens: Math.min(maxTokens, model.maxTokens || maxTokens), ...(effort && effort !== 'off' ? { reasoning: effort } : {}),
      onPayload() { if (++payloadCount > 1) throw failure('Unexpected additional review payload', 'PROVIDER_UNAVAILABLE', 'OUTPUT_REQUEST_COUNT'); },
      async fetch(input, init) {
        if (++requestCount > 1) throw failure('Unexpected additional review request', 'PROVIDER_UNAVAILABLE', 'OUTPUT_REQUEST_COUNT');
        const response = await fetchImpl(input, { ...init, redirect: 'error' });
        if (transport === 'result_tool' && !response.ok) unsupported = await toolsUnsupported(response);
        return response;
      }
    });
    for await (const event of stream) {
      checkAbort();
      if (event.type === 'text_delta' || event.type === 'toolcall_delta') observedBytes += Buffer.byteLength(event.delta || '');
      if (observedBytes > limit) throw failure('Review response exceeds byte limit', 'RESPONSE_TOO_LARGE');
    }
    const message = await stream.result();
    checkAbort();
    if (message.stopReason === 'aborted') throw failure('Provider aborted review', 'PROVIDER_UNAVAILABLE');
    if (message.stopReason === 'length') throw failure('Incomplete review response', 'OUTPUT_TRUNCATED', 'OUTPUT_TRUNCATED');
    if (unsupported) throw failure('Result tools unsupported', 'OUTPUT_TOOL_UNSUPPORTED', 'OUTPUT_TOOL_UNSUPPORTED');
    if (message.stopReason === 'error') throw failure('Review provider failed', 'PROVIDER_UNAVAILABLE');
    if (!['stop', 'toolUse'].includes(message.stopReason)) throw failure('Review response did not complete', 'PROVIDER_UNAVAILABLE');
    if (message.content?.some(item => item.type === 'toolCall' && item.argumentsError)) throw Object.assign(output.outputError([output.issue('', 'JSON')]), { outputCategory: 'OUTPUT_INVALID_JSON' });
    const text = (message.content || []).filter(item => item.type === 'text').map(item => item.text).join('');
    const calls = (message.content || []).filter(item => item.type === 'toolCall');
    const responseBytes = Math.max(observedBytes, Buffer.byteLength(text) + calls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments || {})), 0));
    if (responseBytes > limit) throw failure('Review response exceeds byte limit', 'RESPONSE_TOO_LARGE');
    const envelope = { version: 1, transport, finishReason: 'complete', responseBytes, requestCount: 1, outputLimitEnforced: true };
    if (transport === 'result_tool') {
      if (!calls.length) throw Object.assign(output.outputError([output.issue('', 'SCHEMA')]), { outputCategory: 'OUTPUT_SUBMISSION_MISSING' });
      if (calls.length !== 1 || calls[0].name !== tool.name) throw Object.assign(output.outputError([output.issue('', 'SCHEMA')]), { outputCategory: 'OUTPUT_SUBMISSION_AMBIGUOUS' });
      return { ...envelope, candidate: calls[0].arguments };
    }
    if (calls.length) throw Object.assign(output.outputError([output.issue('', 'SCHEMA')]), { outputCategory: 'OUTPUT_SUBMISSION_AMBIGUOUS' });
    return { ...envelope, text };
  } finally { controller.abort(); }
}
