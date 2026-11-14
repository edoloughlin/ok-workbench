import test from 'node:test';
import assert from 'node:assert/strict';
import { stream } from '../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js';

const model = { id: 'test', provider: 'openai', api: 'openai-completions', baseUrl: 'https://example.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 };
const chunk = { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } };
const response = () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
function recorder() {
  const attempts = [];
  return { attempts, onInferenceAttempt: async metadata => {
    const entry = { metadata, usages: [], finishes: [] }; attempts.push(entry);
    return { requestId: `request-${attempts.length}`, onUsage: async value => entry.usages.push(value), onFinish: async ({ status }) => entry.finishes.push(status) };
  } };
}
async function run(options) {
  const events = [];
  for await (const event of stream(model, { messages: [] }, { apiKey: 'test', ...options })) events.push(event);
  return events.at(-1);
}
test('HTTP retries record physical attempts and cumulative provider usage', async () => {
  const rec = recorder(); let dispatches = 0;
  const result = await run({ ...rec, maxRetries: 1, fetch: async () => ++dispatches === 1 ? new Response('busy', { status: 503, headers: { 'retry-after-ms': '0' } }) : response() });
  assert.equal(result.type, 'done'); assert.equal(dispatches, 2);
  assert.deepEqual(rec.attempts.map(a => a.finishes), [['failed'], ['completed']]);
  assert.equal(rec.attempts[1].metadata.retryOfRequestId, 'request-1');
  assert.deepEqual(rec.attempts[1].usages[0], { usage: chunk.usage, format: 'openai-completions' });
});
test('HTTP accounting failures prevent dispatch or further attempts', async () => {
  let dispatches = 0;
  const blocked = await run({ maxRetries: 2, onInferenceAttempt: async () => { throw Error('disk'); }, fetch: async () => { dispatches++; return response(); } });
  assert.equal(blocked.type, 'error'); assert.equal(blocked.error.usageAccountingFailure, true); assert.equal(dispatches, 0);
  const failedUsage = await run({ maxRetries: 2, onInferenceAttempt: async () => ({ onUsage: async () => { throw Error('disk'); } }), fetch: async () => { dispatches++; return response(); } });
  assert.equal(failedUsage.type, 'error'); assert.equal(failedUsage.error.usageAccountingFailure, true); assert.equal(dispatches, 1);
});
test('HTTP records usage before stream validation and reports aborts', async () => {
  const rec = recorder();
  const incomplete = { ...chunk, choices: [] };
  const result = await run({ ...rec, fetch: async () => new Response(`data: ${JSON.stringify(incomplete)}\n\ndata: [DONE]\n\n`) });
  assert.equal(result.type, 'error'); assert.equal(rec.attempts[0].usages.length, 1); assert.deepEqual(rec.attempts[0].finishes, ['failed']);
  const aborted = recorder(); const controller = new AbortController();
  await run({ ...aborted, signal: controller.signal, fetch: async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); } });
  assert.deepEqual(aborted.attempts[0].finishes, ['aborted']);
  assert.equal((await run({ fetch: async () => response() })).type, 'done');
});

const adapters = [
  { api: 'openai-responses', module: '../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js', format: 'openai-responses', events: [{ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3 } } }] },
  { api: 'azure-openai-responses', module: '../node_modules/@earendil-works/pi-ai/dist/api/azure-openai-responses.js', format: 'openai-responses', events: [{ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3 } } }] },
  { api: 'anthropic-messages', module: '../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js', format: 'anthropic', events: [
    { type: 'message_start', message: { id: 'r', model: 'test', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ] },
  { api: 'mistral-conversations', module: '../node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js', format: 'mistral', events: [chunk] },
  { api: 'pi-messages', module: '../node_modules/@earendil-works/pi-ai/dist/api/pi-messages.js', format: 'pi-messages', events: [{ type: 'done', reason: 'stop', usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } }] },
];
const eventResponse = events => new Response(events.map(event => `event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
for (const adapter of adapters) {
  test(`${adapter.api} records usage and rejects a failed start before dispatch`, async () => {
    const { stream: adapterStream } = await import(adapter.module);
    const adapterModel = { ...model, api: adapter.api, provider: adapter.api === 'anthropic-messages' ? 'anthropic' : 'test' };
    const execute = async options => {
      const events = [];
      for await (const event of adapterStream(adapterModel, { messages: [] }, { apiKey: 'test', ...options })) events.push(event);
      return events.at(-1);
    };
    let dispatches = 0; const rec = recorder();
    const result = await execute({ ...rec, fetch: async () => { dispatches++; return eventResponse(adapter.events); } });
    assert.equal(result.type, 'done', JSON.stringify(result));
    assert.equal(dispatches, 1); assert.equal(rec.attempts.length, 1);
    assert.equal(rec.attempts[0].usages[0].format, adapter.format);
    assert.deepEqual(rec.attempts[0].finishes, ['completed']);
    const blocked = await execute({ onInferenceAttempt: async () => { throw Error('disk'); }, fetch: async () => { dispatches++; return eventResponse(adapter.events); } });
    assert.equal(blocked.type, 'error'); assert.equal(blocked.error.usageAccountingFailure, true); assert.equal(dispatches, 1);
  });
}

test('Anthropic strict-tool rejection starts a distinct fallback attempt', async () => {
  const { stream: anthropicStream } = await import('../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js');
  const adapter = adapters.find(item => item.api === 'anthropic-messages');
  const strictModel = { ...model, api: adapter.api, provider: 'anthropic', compat: { supportsStrictTools: true } };
  const context = { messages: [{ role: 'system', content: '', toolsAdded: [{ name: 'edit', description: 'Edit', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] }] };
  const rec = recorder(); let dispatches = 0; const bodies = [];
  const events = [];
  for await (const event of anthropicStream(strictModel, context, { ...rec, apiKey: 'test', fetch: async (_url, init) => {
    dispatches++; bodies.push(JSON.parse(init.body));
    return dispatches === 1 ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'The compiled grammar is too large' } }), { status: 400, headers: { 'content-type': 'application/json' } }) : eventResponse(adapter.events);
  } })) events.push(event);
  assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
  assert.equal(dispatches, 2); assert.equal(bodies[0].tools[0].strict, true); assert.equal(bodies[1].tools[0].strict, undefined);
  assert.deepEqual(rec.attempts.map(a => a.finishes), [['failed'], ['completed']]);
  assert.equal(rec.attempts[1].metadata.retryOfRequestId, 'request-1');
});
