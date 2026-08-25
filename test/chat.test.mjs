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
  await writeFile(path.join(workspace, 'AGENTS.md'), '# Workspace rules\n\nPreserve workspace evidence.\n');
  await mkdir(path.join(workspace, 'alpha'));
  await writeFile(path.join(workspace, 'alpha', 'AGENTS.md'), '# Alpha rules\n\nUse alpha terminology.\n');
  const legacyThread = { id: 'legacythread', project: 'workspace', provider: 'compatible', model: 'fake-model', effort: '', title: 'Legacy', messages: [{ id: 'legacyassistant', role: 'assistant', content: 'Old reply', createdAt: new Date().toISOString() }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await mkdir(state, { recursive: true }); await writeFile(path.join(state, `${legacyThread.id}.json`), JSON.stringify(legacyThread));
  let rejectNextRequest = false; const providerRequests = [];
  const provider = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    providerRequests.push(JSON.parse(body));
    if (rejectNextRequest) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'API key has expired' } })); return; }
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
    rejectNextRequest = true;
    const failedCreated = await fetch(`http://127.0.0.1:${port}/api/chat/threads`, { method: 'POST', headers, body: JSON.stringify({ project: 'workspace', provider: 'compatible', model: 'fake-model' }) }); assert.equal(failedCreated.status, 201); const failedThread = await failedCreated.json();
    const failedTurn = await fetch(`http://127.0.0.1:${port}/api/chat/threads/${failedThread.id}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: 'Hello again', provider: 'compatible', model: 'fake-model' }) });
    const failedEvents = (await failedTurn.text()).trim().split('\n').map(line => JSON.parse(line)); const failed = failedEvents.find(event => event.type === 'turn.failed'); assert.match(failed?.error || '', /authentication failed.*API key has expired/i);
    const savedFailure = await fetch(`http://127.0.0.1:${port}/api/chat/threads/${failedThread.id}`); const savedFailureThread = await savedFailure.json(); assert.equal(savedFailureThread.messages.at(-1).error, true); assert.match(savedFailureThread.messages.at(-1).content, /authentication failed/i);
    rejectNextRequest = false;
    const projectThreadResponse = await fetch(`http://127.0.0.1:${port}/api/chat/threads`, { method: 'POST', headers, body: JSON.stringify({ project: 'alpha', provider: 'compatible', model: 'fake-model' }) }); assert.equal(projectThreadResponse.status, 201); const projectThread = await projectThreadResponse.json();
    const projectTurn = await fetch(`http://127.0.0.1:${port}/api/chat/threads/${projectThread.id}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: 'Use the project rules', provider: 'compatible', model: 'fake-model' }) }); assert.equal(projectTurn.status, 200); await projectTurn.text();
    const projectPrompt = providerRequests.map(request => request.messages?.find(message => message.role === 'system')?.content).find(content => content?.includes('Use alpha terminology.'));
    assert.match(projectPrompt || '', /Preserve workspace evidence/);
    assert.match(projectPrompt || '', /Workspace instructions: AGENTS\.md[\s\S]*Project instructions: AGENTS\.md/);
    assert.ok(projectPrompt.indexOf('Preserve workspace evidence') < projectPrompt.indexOf('Use alpha terminology.'));
  } finally { child.kill(); await new Promise(resolve => provider.close(resolve)); }
});
