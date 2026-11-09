import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPiTurn } from '../../../src/pi-harness.mjs';
import { observations } from './pi-runtime-fixture.mjs';

const workspace = await mkdtemp(path.join(tmpdir(), 'fetch-harness-')); const stateDir = await mkdtemp(path.join(tmpdir(), 'fetch-harness-state-'));
try {
  const project = path.join(workspace, 'alpha'); await mkdir(project);
  const common = { model: 'fixture-model', messages: [{ role: 'user', content: 'read it' }], workspaceRoot: workspace, stateDir, env: {}, onDelta: () => {}, agentInstructions: '' };
  for (const { provider, projectRoot, workspaceMode } of [{ provider: 'openai', projectRoot: project, workspaceMode: false }, { provider: 'anthropic', projectRoot: workspace, workspaceMode: true }]) {
    const events = []; const approvals = [];
    await runPiTurn({ ...common, provider, projectRoot, workspaceMode, onTool: event => events.push(event), confirmWebFetch: (id, request) => { approvals.push({ id, ...request }); } });
    const observation = observations.at(-1); const tool = observation.tools.find(item => item.name === 'web_fetch');
    assert.equal(tool.label, 'Fetch web page');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, ['url']);
    assert.equal(tool.parameters.properties.max_chars.minimum, 1000); assert.equal(tool.parameters.properties.max_chars.maximum, 40000);
    assert.match(tool.description, /untrusted third-party data/);
    assert.equal(approvals.length, 1); assert.equal(approvals[0].id, 'tool-call'); assert.equal(approvals[0].url, 'https://example.com/path?secret=1');
    assert.deepEqual(events.map(event => event.phase), ['started', 'completed', 'started', 'failed', 'started', 'failed']);
    assert.deepEqual(events[4].targets, []); assert.deepEqual(events[5].targets, []);
    assert.ok(approvals[0].signal instanceof AbortSignal);
    assert.deepEqual(events[0].targets, ['https://example.com']);
    assert.deepEqual(events[1].targets, ['https://example.com', 'https://other.example.net']);
    assert.ok(events.every(event => !('changed' in event)));
    assert.ok(!JSON.stringify(events.map(event => event.targets)).includes('secret'));
    assert.equal(observation.calls[0].result.details.result.text, 'fixture content');
    assert.deepEqual(JSON.parse(observation.calls[0].result.content[0].text), observation.calls[0].result.details.result);
    assert.match(observation.calls[1].error, /^NETWORK_ERROR:/);
    assert.match(observation.loader.options.systemPromptOverride(), /Every fetch and redirect requires separate user confirmation/);
  }
  const closedEvents = [];
  await runPiTurn({ ...common, provider: 'openai', projectRoot: project, onTool: event => closedEvents.push(event) });
  assert.equal(closedEvents.filter(event => event.phase === 'failed').length, 3);
  assert.ok(closedEvents.filter(event => event.phase === 'failed').every(event => event.error.startsWith('CONFIRMATION_REQUIRED:')));
  await runPiTurn({ ...common, provider: 'openai', projectRoot: workspace, noWorkspaceTools: true, systemPrompt: 'CUSTOM PROMPT' });
  const zero = observations.at(-1);
  assert.equal(zero.tools.length, 0);
  assert.match(zero.loader.options.systemPromptOverride(), /CUSTOM PROMPT/);
  assert.doesNotMatch(zero.loader.options.systemPromptOverride(), /Every fetch and redirect/);
} finally { await rm(workspace, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }); }
