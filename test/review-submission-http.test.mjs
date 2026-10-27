import assert from 'node:assert/strict';
import http from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { collectReviewSubmission } from '../src/review-submission.mjs';
import output from '../src/workspace-review-output.js';

const candidate = { assessment: { projectId: 'A', confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: 'Ship A', assessment: 'Review evidence', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly', evidenceIds: ['s'], claimEvidence: [] }, attentionCandidates: [] };
const callName = 'submit_project_assessment';
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function responseEvents(api, { count = 1, name = callName, argumentsText = JSON.stringify(candidate), text = '', incomplete = false, truncated = false } = {}) {
  if (api === 'openai-completions') {
    const tool_calls = Array.from({ length: count }, (_, index) => ({ index, id: `call_${index}`, type: 'function', function: { name, arguments: argumentsText } }));
    return `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...(text ? { content: text } : {}), ...(count ? { tool_calls } : {}) }, finish_reason: null }] })}\n\n` + (incomplete ? '' : `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : count ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }
  if (api === 'anthropic-messages') {
    let data = event('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    let index = 0;
    if (text) { data += event('content_block_start', { index, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index, delta: { type: 'text_delta', text } }) + event('content_block_stop', { index }); index++; }
    for (let i = 0; i < count; i++, index++) data += event('content_block_start', { index, content_block: { type: 'tool_use', id: `call_${i}`, name, input: {} } }) + event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: argumentsText } }) + event('content_block_stop', { index });
    return data + (incomplete ? '' : event('message_delta', { delta: { stop_reason: truncated ? 'max_tokens' : count ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) + event('message_stop', {}));
  }
  let data = event('response.created', { response: { id: 'fixture', status: 'in_progress', output: [] } });
  const items = [];
  if (text) {
    const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    data += event('response.output_item.added', { output_index: 0, item: { ...item, content: [] } }) + event('response.output_text.delta', { output_index: 0, content_index: 0, delta: text }) + event('response.output_item.done', { output_index: 0, item }); items.push(item);
  }
  for (let index = 0; index < count; index++) {
    const item = { type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name, arguments: argumentsText, status: 'completed' }; const output_index = items.length;
    data += event('response.output_item.added', { output_index, item: { ...item, arguments: '', status: 'in_progress' } }) + event('response.function_call_arguments.delta', { output_index, delta: argumentsText }) + event('response.output_item.done', { output_index, item }); items.push(item);
  }
  return data + (incomplete ? '' : event(truncated ? 'response.incomplete' : 'response.completed', { response: { id: 'fixture', status: truncated ? 'incomplete' : 'completed', output: items, ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
}
async function withEndpoint(api, fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ok-review-http-')); const requests = []; let respond = () => ({ data: responseEvents(api) });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8')); requests.push({ body, url: req.url });
    const result = respond(body);
    res.writeHead(result.status || 200, { 'content-type': result.status ? 'application/json' : 'text/event-stream' }); res.end(result.data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64')}.fixture`;
    await writeFile(path.join(stateDir, 'auth.json'), JSON.stringify({ 'local-review': { type: 'oauth', access: token, refresh: 'synthetic-refresh', expires: Date.now() + 3600000 } }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({ authPath: path.join(stateDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('local-review', { api, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, oauth: { name: 'Synthetic login', getApiKey: credential => credential.access, login: async () => { throw new Error('No interactive login in tests'); }, refreshToken: async () => { throw new Error('No token refresh in tests'); } },  models: [{ id: 'fixture', name: 'Fixture', api, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }] });
    const model = runtime.getPhysicalModel('local-review', 'fixture');
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.isUsingOAuth('local-review'), true);
    const submit = (options = {}) => collectReviewSubmission({ runtime, model, stage: 'project', prompt: 'Review synthetic evidence only.', evidence: {}, transport: 'result_tool', maxTokens: 4096, timeout: 5000, ...options });
    await fn({ requests, submit, setResponse: value => { respond = value; }, runtime, model });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(stateDir, { recursive: true, force: true }); }
}

for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses', 'openai-codex-responses']) {
  test(`${api}: real Pi runtime submits a result in one local HTTP request`, async () => {
    await withEndpoint(api, async ({ requests, submit }) => {
      const envelope = await submit();
      assert.deepEqual(envelope.candidate, candidate); assert.equal(envelope.requestCount, 1); assert.equal(requests.length, 1);
      const tools = requests[0].body.tools; assert.equal(tools.length, 1);
      assert.equal(tools[0].name || tools[0].function?.name, callName);
      assert.ok(!JSON.stringify(tools).includes('read_file')); assert.ok(!JSON.stringify(tools).includes('displayTarget'));
    });
  });
  test(`${api}: provider rejection is explicit and never triggers SDK retries`, async () => {
    await withEndpoint(api, async ({ requests, submit, setResponse }) => {
      setResponse(() => ({ status: 400, data: JSON.stringify({ error: { code: 'unsupported_parameter', param: 'tools', message: 'private diagnostic' } }) }));
      await assert.rejects(submit(), error => error.code === 'OUTPUT_TOOL_UNSUPPORTED' && !error.message.includes('private'));
      assert.equal(requests.length, 1);
      setResponse(() => ({ data: responseEvents(api, { count: 0, text: JSON.stringify(candidate) }) }));
      const fallback = await submit({ transport: 'json_text' }); assert.equal(fallback.text, JSON.stringify(candidate));
      assert.equal(requests.length, 2); assert.equal(requests[1].body.tools?.length || 0, 0);
    });
  });
}

for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses', 'openai-codex-responses']) test(`${api}: rejects duplicate, unexpected, malformed, absent, and truncated submissions`, async () => {
  await withEndpoint(api, async ({ requests, submit, setResponse }) => {
    for (const [options, code] of [[{ count: 2 }, 'INVALID_REVIEW'], [{ name: 'read_file' }, 'INVALID_REVIEW'], [{ argumentsText: '{invalid' }, 'INVALID_REVIEW'], [{ count: 0, text: 'No submission' }, 'INVALID_REVIEW'], [{ truncated: true }, 'OUTPUT_TRUNCATED'], [{ incomplete: true }, 'PROVIDER_UNAVAILABLE']]) {
      const before = requests.length; setResponse(() => ({ data: responseEvents(api, options) }));
      await assert.rejects(submit(), { code }); assert.equal(requests.length, before + 1);
    }
    setResponse(() => ({ status: 429, data: JSON.stringify({ error: { code: 'rate_limit_exceeded' } }) }));
    const before = requests.length; await assert.rejects(submit(), { code: 'PROVIDER_UNAVAILABLE' }); assert.equal(requests.length, before + 1);
  });
});

test('known Pi 1.4 protocols enable structured submission without a model evaluation registry', () => {
  const resolver = output.createCapabilityResolver();
  for (const endpoint of ['github-copilot:openai-completions', 'github-copilot:anthropic-messages', 'openai-codex:openai-codex-responses', 'openai:openai-responses']) {
    const selection = { adapter: 'pi', endpoint, model: 'available-chat-model', runtimeVersion: '1.4.0' };
    assert.equal(resolver.resolve(selection).transport, 'result_tool'); assert.equal(resolver.resolve(selection).resultTool, 'supported');
    assert.equal(resolver.resolve(selection, 'json_text').transport, 'json_text');
    resolver.markUnsupported(selection); assert.equal(resolver.resolve(selection).transport, 'json_text');
    assert.equal(resolver.resolve({ ...selection, model: 'different' }).transport, 'result_tool');
    assert.equal(resolver.resolve({ ...selection, runtimeVersion: '9.0.0' }).transport, 'json_text');
  }
});
