import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function availablePort() { const probe = createServer(); const port = await listen(probe); await new Promise(resolve => probe.close(resolve)); return port; }
async function startWorkbench(environment, port) {
  const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], { env: { ...process.env, ...environment, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('workbench did not start')), 5000); child.stdout.on('data', () => { clearTimeout(timer); resolve(); }); child.on('error', reject); child.on('exit', code => reject(new Error(`workbench exited ${code}`))); });
  return child;
}
test('chat coordinator streams and persists a compatible-provider turn without real credentials', { skip: !process.env.OK_WORKBENCH_INTEGRATION }, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-chat-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-chat-state-'));
  await writeFile(path.join(workspace, 'index.md'), '# Chat workspace\n');
  const legacyThread = { id: 'legacythread', project: 'workspace', provider: 'compatible', model: 'fake-model', effort: '', title: 'Legacy', messages: [{ id: 'legacyassistant', role: 'assistant', content: 'Old reply', createdAt: new Date().toISOString() }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await mkdir(state, { recursive: true }); await writeFile(path.join(state, `${legacyThread.id}.json`), JSON.stringify(legacyThread));
  const provider = createServer(async (request, response) => {
    for await (const _ of request) { /* consume request without logging its headers */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"Fake reply"}}]}\n\ndata: [DONE]\n\n');
  });
  const providerPort = await listen(provider); const port = await availablePort();
  const child = await startWorkbench({ OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, LLM_COMPATIBLE_API_KEY: 'test-only', LLM_COMPATIBLE_BASE_URL: `http://127.0.0.1:${providerPort}`, LLM_COMPATIBLE_MODEL: 'fake-model' }, port);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/workspace/`); const csrf = (await page.text()).match(/name="ok-workbench-csrf" content="([^"]+)"/)?.[1]; assert.ok(csrf);
    const loadedLegacy = await fetch(`http://127.0.0.1:${port}/api/chat/threads/${legacyThread.id}`, { headers: { 'x-ok-workbench-csrf': csrf } }); assert.equal(loadedLegacy.status, 200); assert.equal((await loadedLegacy.json()).messages[0].turnId, undefined);
    const status = await fetch(`http://127.0.0.1:${port}/api/chat/status`); const statusBody = await status.json(); assert.equal(statusBody.enabled, true); assert.ok(statusBody.providers.some(provider => provider.id === 'compatible'));
    const headers = { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf };
    const created = await fetch(`http://127.0.0.1:${port}/api/chat/threads`, { method: 'POST', headers, body: JSON.stringify({ project: 'workspace', provider: 'compatible', model: 'fake-model' }) });
    assert.equal(created.status, 201); const thread = await created.json();
    const turn = await fetch(`http://127.0.0.1:${port}/api/chat/threads/${thread.id}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: 'Hello', provider: 'compatible', model: 'fake-model' }) });
    assert.equal(turn.status, 200); const events = (await turn.text()).trim().split('\n').map(line => JSON.parse(line)); assert.ok(events.some(event => event.type === 'message.delta' && event.delta === 'Fake reply')); assert.ok(events.some(event => event.type === 'turn.completed'));
    for (const event of events.filter(event => event.type === 'turn.status')) assert.deepEqual(Object.keys(event).sort(), ['sequence', 'state', 'thread_id', 'turn_id', 'type']);
    const started = events.find(event => event.type === 'turn.started'); assert.ok(started?.turn_id);
    const saved = await fetch(`http://127.0.0.1:${port}/api/chat/threads/${thread.id}`); const savedThread = await saved.json(); assert.equal(savedThread.messages.at(-1).content, 'Fake reply'); assert.equal(savedThread.messages.at(-1).model, 'fake-model'); assert.equal(savedThread.messages.at(-1).effort, ''); assert.equal(savedThread.messages.at(-1).turnId, started.turn_id);
  } finally { child.kill(); await new Promise(resolve => provider.close(resolve)); }
});
