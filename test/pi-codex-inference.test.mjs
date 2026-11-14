import test from 'node:test';
import assert from 'node:assert/strict';
const { stream } = await import(process.env.PI_CODEX_TEST_ADAPTER || '../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js');

const model = { id: 'codex-test', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://example.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 };
const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test' } })).toString('base64url')}.x`;
const context = { messages: [] };
const completion = { type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } };
const sse = event => new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200 });
function recorder() {
  const attempts = [];
  return { attempts, onInferenceAttempt: async metadata => {
    const entry = { metadata, usages: [], finishes: [] }; attempts.push(entry);
    return { requestId: `request-${attempts.length}`, onUsage: async value => entry.usages.push(value), onFinish: async value => entry.finishes.push(value.status) };
  } };
}
async function run(options) {
  const events = [];
  for await (const event of stream(model, context, { apiKey: token, ...options })) events.push(event);
  return events.at(-1);
}

test('SSE records each physical retry and provider usage', async () => {
  const rec = recorder(); let dispatches = 0;
  const result = await run({ ...rec, transport: 'sse', maxRetries: 1, fetch: async () => ++dispatches === 1 ? new Response('busy', { status: 503, headers: { 'retry-after-ms': '0' } }) : sse(completion) });
  assert.equal(result.type, 'done'); assert.equal(dispatches, 2); assert.equal(rec.attempts.length, 2);
  assert.deepEqual(rec.attempts.map(a => a.finishes), [['failed'], ['completed']]);
  assert.equal(rec.attempts[1].metadata.retryOfRequestId, 'request-1');
  assert.deepEqual(rec.attempts[1].usages[0], { usage: completion.response.usage, format: 'openai-responses' });
});

test('SSE preserves usage on provider rejection and does not dispatch after rejected accounting', async () => {
  const rec = recorder(); let dispatches = 0;
  const failed = { type: 'response.failed', response: { status: 'failed', error: { message: 'invalid' }, usage: completion.response.usage } };
  const result = await run({ ...rec, transport: 'sse', fetch: async () => { dispatches++; return sse(failed); } });
  assert.equal(result.type, 'error'); assert.equal(dispatches, 1); assert.equal(rec.attempts[0].usages.length, 1); assert.deepEqual(rec.attempts[0].finishes, ['failed']);
  const blocked = await run({ transport: 'sse', maxRetries: 2, onInferenceAttempt: async () => { throw new Error('store unavailable'); }, fetch: async () => { dispatches++; return sse(completion); } });
  assert.equal(blocked.type, 'error'); assert.equal(blocked.error.usageAccountingFailure, true); assert.equal(dispatches, 1);
});

test('WebSocket sends are counted, and transport failure falls back to SSE', async () => {
  const previous = globalThis.WebSocket; let sends = 0; let fetches = 0;
  class FakeSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send() { sends++; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket;
  try {
    const rec = recorder();
    const result = await run({ ...rec, transport: 'auto', env: {}, fetch: async () => { fetches++; return sse(completion); } });
    assert.equal(result.type, 'done'); assert.equal(sends, 1); assert.equal(fetches, 1);
    assert.deepEqual(rec.attempts.map(a => a.metadata.transport), ['websocket', 'sse']);
    assert.deepEqual(rec.attempts.map(a => a.finishes), [['failed'], ['completed']]);
    assert.equal(rec.attempts[1].metadata.retryOfRequestId, 'request-1');
  } finally { globalThis.WebSocket = previous; }
});

test('cumulative snapshots are delivered separately and usage callback failures stop dispatch', async () => {
  const rec = recorder(); let dispatches = 0;
  const earlier = { type: 'response.in_progress', response: { usage: { input_tokens: 8, output_tokens: 1 } } };
  const body = [earlier, completion].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const result = await run({ ...rec, transport: 'sse', fetch: async () => { dispatches++; return new Response(body); } });
  assert.equal(result.type, 'done'); assert.equal(rec.attempts[0].usages.length, 2);
  const blocked = await run({ transport: 'sse', maxRetries: 2, onInferenceAttempt: async () => ({ onUsage: async () => { throw Error('disk'); } }), fetch: async () => { dispatches++; return sse(completion); } });
  assert.equal(blocked.type, 'error'); assert.equal(blocked.error.usageAccountingFailure, true); assert.equal(dispatches, 2);
});

test('aborted dispatch receives an aborted terminal status; no-hook calls still work', async () => {
  const controller = new AbortController(); const rec = recorder();
  const result = await run({ ...rec, transport: 'sse', signal: controller.signal, fetch: async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); } });
  assert.equal(result.type, 'error'); assert.deepEqual(rec.attempts[0].finishes, ['aborted']);
  assert.equal((await run({ transport: 'sse', fetch: async () => sse(completion) })).type, 'done');
});

test('WebSocket start failure prevents both send and fallback', async () => {
  const previous = globalThis.WebSocket; let sends = 0; let fetches = 0;
  class FakeSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send() { sends++; }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket;
  try {
    const result = await run({ transport: 'auto', env: {}, onInferenceAttempt: async () => { throw Error('disk'); }, fetch: async () => { fetches++; return sse(completion); } });
    assert.equal(result.type, 'error'); assert.equal(result.error.usageAccountingFailure, true); assert.equal(sends, 0); assert.equal(fetches, 0);
  } finally { globalThis.WebSocket = previous; }
});

test('WebSocket retries inference sends and records successful response usage', async () => {
  const previous = globalThis.WebSocket; let sends = 0;
  class FakeSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send() {
      sends++;
      const event = sends === 1 ? { type: 'error', code: 'previous_response_not_found', message: 'missing' } : completion;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })));
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket;
  try {
    const rec = recorder();
    const result = await run({ ...rec, transport: 'auto', env: {}, fetch: async () => { throw Error('unexpected fallback'); } });
    assert.equal(result.type, 'done'); assert.equal(sends, 2); assert.equal(rec.attempts.length, 2);
    assert.deepEqual(rec.attempts.map(a => a.finishes), [['failed'], ['completed']]);
    assert.equal(rec.attempts[1].metadata.retryOfRequestId, 'request-1');
    assert.deepEqual(rec.attempts[1].usages[0], { usage: completion.response.usage, format: 'openai-responses' });
  } finally { globalThis.WebSocket = previous; }
});
