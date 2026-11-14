import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js';
import { compact } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { installAgentInferenceObserver } from '../src/pi-harness.mjs';

const model = { id: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'https://example.test/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
function completion(tool, sequence = 1) {
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${sequence}`, type: 'function', function: { name: 'lookup', arguments: '{}' } }] } : { role: 'assistant', content: 'Summary or answer' };
  return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
function setup(onAttempt, continuations = 1) {
  let dispatches = 0; let toolRuns = 0;
  const agent = new Agent({ initialState: { model, systemPrompt: 'Test', tools: [{ name: 'lookup', label: 'Lookup', description: 'Look up a value', parameters: { type: 'object', properties: {} }, execute: async () => { toolRuns++; return { content: [{ type: 'text', text: 'found' }], details: {} }; } }] },
    getApiKey: () => 'test', streamFn: (m, c, options) => streamSimple(m, c, { ...options, apiKey: 'test', fetch: async () => completion(++dispatches <= continuations, dispatches) }) });
  const accounting = installAgentInferenceObserver(agent, onAttempt);
  return { agent, accounting, get dispatches() { return dispatches; }, get toolRuns() { return toolRuns; } };
}

test('actual Pi agent forwards lifecycle through generation, tool continuation, and compaction', async () => {
  const attempts = []; const x = setup(async metadata => { const attempt = { metadata, statuses: [] }; attempts.push(attempt); return { onFinish: async ({ status }) => attempt.statuses.push(status) }; });
  await x.agent.prompt('Run the lookup');
  assert.equal(x.toolRuns, 1); assert.equal(x.dispatches, 2); assert.equal(attempts.length, 2);
  const preparation = { firstKeptEntryId: 'kept', messagesToSummarize: x.agent.state.messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { read: new Set(), written: new Set(), edited: new Set() } };
  const summary = await compact(preparation, model, 'test', undefined, undefined, undefined, undefined, x.agent.streamFunction);
  assert.match(summary.summary, /Summary or answer/); assert.equal(x.dispatches, 3); assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(a => a.statuses), [['completed'], ['completed'], ['completed']]);
  assert.ok(attempts.every(a => a.metadata.model === 'fixture'));
});

test('accounting failure prevents a later actual agent or compaction dispatch', async () => {
  const x = setup(async () => { throw Error('storage unavailable'); });
  await x.agent.prompt('Run the lookup');
  assert.equal(x.dispatches, 0); assert.ok(x.accounting.failure?.usageAccountingFailure);
  await assert.rejects(async () => x.agent.streamFunction(model, { messages: [] }, {}), { code: 'USAGE_STORE_UNAVAILABLE' });
  assert.equal(x.dispatches, 0);
});

test('real Pi review transport records usage before tool or JSON validation and caps requests', async () => {
  const { collectReviewSubmission } = await import('../src/review-submission.mjs');
  const { parseReviewJSON } = (await import('../src/workspace-review-pipeline.js')).default;
  const attempts = []; let dispatches = 0; let mode = 'tool';
  const onInferenceAttempt = async metadata => {
    const entry = { metadata, usages: [], statuses: [] }; attempts.push(entry);
    return { onUsage: async value => entry.usages.push(value), onFinish: async ({ status }) => entry.statuses.push(status) };
  };
  const runtime = { streamSimple: (m, context, options) => streamSimple(m, context, { ...options, apiKey: 'test' }) };
  const fetchImpl = async () => {
    dispatches++;
    if (mode === 'rate') return new Response('busy', { status: 503 });
    const delta = mode === 'tool' ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'submit_project_assessment', arguments: '{invalid' } }] } : { role: 'assistant', content: '{invalid' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const submit = transport => collectReviewSubmission({ runtime, model, stage: 'project', prompt: 'Review', evidence: {}, transport, onInferenceAttempt, fetchImpl });
  await assert.rejects(submit('result_tool'), { code: 'INVALID_REVIEW' });
  assert.equal(dispatches, 1); assert.equal(attempts.length, 1); assert.ok(attempts[0].usages.length); assert.deepEqual(attempts[0].statuses, ['completed']);
  mode = 'text'; const envelope = await submit('json_text');
  assert.throws(() => parseReviewJSON(envelope.text));
  assert.equal(dispatches, 2); assert.equal(attempts.length, 2); assert.ok(attempts[1].usages.length); assert.deepEqual(attempts[1].statuses, ['completed']);
  mode = 'rate'; await assert.rejects(submit('json_text'), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(dispatches, 3); assert.equal(attempts.length, 3); assert.deepEqual(attempts[2].statuses, ['failed']);
});

test('usage persistence failure stops the agent before tool continuation', async () => {
  const x = setup(async () => ({ onUsage: async () => { throw Error('storage unavailable'); } }));
  await x.agent.prompt('Run the lookup');
  assert.equal(x.dispatches, 1); assert.equal(x.toolRuns, 0); assert.ok(x.accounting.failure?.usageAccountingFailure);
  await assert.rejects(async () => x.agent.streamFunction(model, { messages: [] }, {}), { code: 'USAGE_STORE_UNAVAILABLE' });
  assert.equal(x.dispatches, 1);
});

test('ModelRuntime reports the routed physical identity for a selected virtual model', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-routing-test-'));
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('physical-provider', { api: 'openai-completions', baseUrl: 'https://example.test/v1', apiKey: 'test', models: [{ id: 'physical-model', name: 'Physical', api: 'openai-completions', reasoning: false, input: ['text'], cost: model.cost, contextWindow: 8192, maxTokens: 1024 }] });
    await runtime.refresh({ allowNetwork: false });
    const physical = runtime.getPhysicalModel('physical-provider', 'physical-model');
    assert.ok(physical);
    runtime.registerVirtualModel({ provider: 'virtual-provider', id: 'hybrid', name: 'Hybrid', route: () => ({ model: physical, thinkingLevel: 'off' }) });
    const selected = runtime.getModel('virtual-provider', 'hybrid');
    assert.ok(selected); assert.equal(selected.api, 'pi-virtual');
    const attempts = []; let dispatches = 0;
    const agent = new Agent({ initialState: { model: selected }, streamFn: (m, c, options) => runtime.streamSimple(m, c, { ...options, fetch: async () => { dispatches++; return completion(false); } }) });
    installAgentInferenceObserver(agent, async metadata => { attempts.push(metadata); });
    await agent.prompt('Route this request');
    assert.equal(dispatches, 1); assert.equal(attempts.length, 1);
    assert.equal(attempts[0].provider, 'physical-provider');
    assert.equal(attempts[0].model, 'physical-model');
    assert.equal(attempts[0].api, 'openai-completions');
    assert.equal(agent.state.messages.at(-1).model, 'physical-model');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('two actual tool continuations produce three durable requests in one original project operation', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { UsageStore } = (await import('../src/usage-store.js')).default;
  const { createUsageCapture } = (await import('../src/usage-capture.js')).default;
  const stateDir = await mkdtemp(path.join(tmpdir(), 'usage-tool-continuations-'));
  try {
    const store = new UsageStore({ stateDir, workspaceRoot: '/fixture-workspace' });
    await store.init();
    const operation = await store.startOperation({ activity: 'chat', projectId: 'A', trigger: 'user' });
    const capture = createUsageCapture({ store, context: { operationId: operation.operationId, activity: 'chat', projectId: 'A', projectLabel: 'Original project', trigger: 'user', requestedProvider: 'fixture', requestedModel: 'fixture' } });
    const x = setup(capture, 2);
    await x.agent.prompt('Run the tools');
    const snapshot = await store.snapshot();
    assert.equal(x.dispatches, 3); assert.equal(x.toolRuns, 2);
    assert.equal(snapshot.operations.length, 1); assert.equal(snapshot.requests.length, 3);
    assert.ok(snapshot.requests.every(r => r.operationId === operation.operationId && r.projectId === 'A'));
    assert.deepEqual(snapshot.requests.map(r => r.subtask), ['generation', 'tool_continuation', 'tool_continuation']);
    assert.equal(snapshot.requests.reduce((sum,r) => sum + r.totalTokens, 0), 18);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
