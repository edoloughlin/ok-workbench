import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }

test('HTTP chat records private scoped usage and serves snapshot, filters and export', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'usage-http-workspace-')); const state = await mkdtemp(path.join(tmpdir(), 'usage-http-state-'));
  let child; let dispatches = 0; const provider = createServer(async (req, res) => {
    for await (const _ of req) {} dispatches++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Private assistant response' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await mkdir(path.join(workspace, 'A')); await writeFile(path.join(workspace, 'A', 'index.md'), '# A\n');
    const providerPort = await listen(provider); const port = await freePort(); let assetPort = await freePort(); while (assetPort === port) assetPort = await freePort();
    child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PI_OFFLINE: '1', OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(port), OK_WORKBENCH_ASSET_PORT: String(assetPort), LLM_COMPATIBLE_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, LLM_COMPATIBLE_API_KEY: 'private-key', LLM_COMPATIBLE_MODEL: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`server timed out: ${stderr}`)), 10000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('exit', code => reject(Error(`server exited ${code}: ${stderr}`))); });
    const base = `http://127.0.0.1:${port}`; const csrf = (await (await fetch(`${base}/api/chat/session`)).json()).csrf;
    const headers = { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf };
    const created = await fetch(`${base}/api/chat/threads`, { method: 'POST', headers, body: JSON.stringify({ project: 'A', provider: 'compatible', model: 'fixture' }) }); assert.equal(created.status, 201); const thread = await created.json();
    const turn = await fetch(`${base}/api/chat/threads/${thread.id}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: 'Private user prompt', provider: 'compatible', model: 'fixture' }) });
    assert.equal(turn.status, 200); const events = (await turn.text()).trim().split('\n').map(line => JSON.parse(line));
    const start = events.find(e => e.type === 'turn.started'); assert.ok(events.some(e => e.type === 'turn.completed')); assert.equal(dispatches, 2);
    const query = 'preset=last_24_hours&bucket=hour&timezone=UTC&breakdown=operations';
    const response = await fetch(`${base}/api/usage/report?${query}`); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private/); assert.match(response.headers.get('cache-control'), /no-store/); const report = await response.json();
    assert.equal(report.totals.requests, 2); assert.equal(report.totals.totalTokens, 26); assert.equal(report.totals.operations, 1);
    const detail = await (await fetch(`${base}/api/usage/operations/${start.turn_id}?snapshot=${report.snapshot}`)).json();
    assert.equal(detail.operation.projectId, 'A'); assert.equal(detail.operation.promptSubmissions.length, 1); assert.equal(detail.requests.length, 2);
    assert.deepEqual(detail.requests.map(r => r.activity).sort(), ['chat', 'system']); assert.ok(detail.requests.every(r => r.projectId === 'A'));
    const filtered = await (await fetch(`${base}/api/usage/report?${query}&project=A&activity=chat`)).json(); assert.equal(filtered.totals.requests, 1); assert.equal(filtered.totals.totalTokens, 13);
    const invalid = await fetch(`${base}/api/usage/report?${query}&workspaceKey=other`); assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${base}/api/usage/report?${query}`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/usage/report?${query}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => { const req = httpRequest(`${base}/api/usage/report?${query}`, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }); assert.equal(badHost, 421);
    const write = await fetch(`${base}/api/usage/report?${query}`, { method: 'POST' }); assert.notEqual(write.status, 200);
    const csv = await (await fetch(`${base}/api/usage/export?${query}&snapshot=${report.snapshot}`)).text(); assert.match(csv, /Total tokens/); assert.match(csv, /26/);
    const next = await fetch(`${base}/api/chat/threads/${thread.id}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: 'Another private prompt' }) }); await next.text();
    const frozen = await (await fetch(`${base}/api/usage/report?${query}&snapshot=${report.snapshot}`)).json(); assert.equal(frozen.totals.requests, 2);
    const fresh = await (await fetch(`${base}/api/usage/report?${query}`)).json(); assert.equal(fresh.totals.requests, 3);
    const saved = JSON.stringify(detail) + csv; for (const secret of ['Private user prompt', 'Private assistant response', 'private-key']) assert.ok(!saved.includes(secret));
    const usageRoot = path.join(state, 'usage'); const journals = (await readdir(usageRoot, { recursive: true })).filter(f => f.endsWith('.jsonl'));
    const ledger = (await Promise.all(journals.map(f => readFile(path.join(usageRoot, f), 'utf8')))).join('');
    for (const secret of ['Private user prompt', 'Private assistant response', 'private-key']) assert.ok(!ledger.includes(secret));
  } finally { if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test('accepted steering adds metadata to the original project operation without adding a request', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'usage-steer-workspace-')); const state = await mkdtemp(path.join(tmpdir(), 'usage-steer-state-')); let child;
  try {
    for (const id of ['A', 'B']) { await mkdir(path.join(workspace, id)); await writeFile(path.join(workspace, id, 'index.md'), `# ${id}\n`); }
    const port = await freePort(); let assetPort = await freePort(); while (assetPort === port) assetPort = await freePort();
    child = spawn(process.execPath, ['--experimental-loader', path.resolve('test/fixtures/usage/harness-loader.mjs'), 'dist/server.js'], { env: { ...process.env, PI_OFFLINE: '1', OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(port), OK_WORKBENCH_ASSET_PORT: String(assetPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`server timed out: ${stderr}`)), 10000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('exit', code => reject(Error(`server exited ${code}: ${stderr}`))); });
    const base = `http://127.0.0.1:${port}`; const csrf = (await (await fetch(`${base}/api/chat/session`)).json()).csrf; const headers = { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf };
    const thread = await (await fetch(`${base}/api/chat/threads`, { method: 'POST', headers, body: JSON.stringify({ project: 'A', provider: 'openai', model: 'fixture' }) })).json();
    const response = await fetch(`${base}/api/chat/threads/${thread.id}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: 'private initial prompt' }) });
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = [];
    while (!events.some(e => e.type === 'turn.steering' && e.available)) { const { value, done } = await reader.read(); assert.equal(done, false); buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) if (line) events.push(JSON.parse(line)); }
    const turnId = events.find(e => e.type === 'turn.started').turn_id;
    const steered = await fetch(`${base}/api/chat/threads/${thread.id}/turns/${turnId}/steer`, { method: 'POST', headers, body: JSON.stringify({ message: 'private steering text', project: 'B' }) }); assert.equal(steered.status, 202);
    while (!(await reader.read()).done) {}
    const detail = await (await fetch(`${base}/api/usage/operations/${turnId}`)).json();
    assert.equal(detail.operation.projectId, 'A'); assert.equal(detail.operation.promptSubmissions.length, 2); assert.equal(detail.requests.length, 2); assert.ok(detail.requests.every(r => r.projectId === 'A'));
    for (const privateText of ['private initial prompt', 'private steering text']) assert.ok(!JSON.stringify(detail).includes(privateText));
  } finally { if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

for (const nested of [true, false]) test(`usage state is private when state is ${nested ? 'inside' : 'equal to'} the workspace`, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'usage-private-')); const state = nested ? path.join(workspace, 'state') : workspace; let child; const requests = [];
  const provider = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; requests.push(body); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {\"choices\":[{\"delta\":{\"content\":\"invalid\"}}]}\n\ndata: [DONE]\n\n'); });
  try {
    await mkdir(state, { recursive: true }); await mkdir(path.join(workspace, 'A')); await writeFile(path.join(workspace, 'A', 'status.md'), 'Work is active.');
    const providerPort = await listen(provider); const port = await freePort(); let assetPort = await freePort(); while (assetPort === port) assetPort = await freePort();
    child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PI_OFFLINE: '1', OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(port), OK_WORKBENCH_ASSET_PORT: String(assetPort), LLM_COMPATIBLE_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, LLM_COMPATIBLE_API_KEY: 'test', LLM_COMPATIBLE_MODEL: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`server timed out: ${stderr}`)), 10000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('exit', code => reject(Error(`server exited ${code}: ${stderr}`))); });
    const marker = path.join(state, 'usage', 'secret.md'); await writeFile(marker, 'Private usage marker');
    const relative = nested ? 'state/usage/secret.md' : 'usage/secret.md'; const base = `http://127.0.0.1:${port}`;
    const doc = await fetch(`${base}/api/document?path=${encodeURIComponent(`/workspace/${relative}`)}`); assert.notEqual(doc.status, 200); assert.ok(!(await doc.text()).includes('Private usage marker'));
    const asset = await fetch(`http://127.0.0.1:${assetPort}/workspace/${relative}`); assert.notEqual(asset.status, 200); assert.ok(!(await asset.text()).includes('Private usage marker'));
    const root = await fetch(`${base}/api/document?path=/workspace`); assert.ok(!(await root.text()).includes('Private usage marker'));
    await mkdir(path.join(state, 'usage', 'hidden-project')); await writeFile(path.join(state, 'usage', 'hidden-project', 'status.md'), 'Private usage marker');
    const csrf = (await (await fetch(`${base}/api/chat/session`)).json()).csrf; const headers = { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf };
    const settings = await fetch(`${base}/api/workspace-review/settings`, { method: 'PUT', headers, body: JSON.stringify({ provider: 'compatible', model: 'fixture', automatic: false, confirmations: { belowRecommendedModel: true }, expectedRevision: 0 }) }); assert.equal(settings.status, 200, await settings.text());
    assert.equal((await fetch(`${base}/api/workspace-review/runs`, { method: 'POST', headers, body: '{}' })).status, 202);
    let reviewState; for (let i = 0; i < 250; i++) { reviewState = await (await fetch(`${base}/api/workspace-review`)).json(); if (reviewState.job?.state !== 'running') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.notEqual(reviewState.job?.state, 'running'); assert.ok(requests.length, 'review did not dispatch'); assert.ok(!requests.join('').includes('Private usage marker')); assert.ok(!requests.join('').includes('hidden-project'));

  } finally { if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(workspace, { recursive: true, force: true }); }
});
