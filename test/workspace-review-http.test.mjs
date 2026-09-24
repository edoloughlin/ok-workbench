import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
function request(port, pathname, { method = 'GET', body, headers = {} } = {}) { return new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { Host: `localhost:${port}`, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })); }); req.once('error', reject); req.end(body); }); }
async function start(workspace, state, serverPort, assetPort, extraEnv = {}) { const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], { env: { ...process.env, OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(serverPort), OK_WORKBENCH_ASSET_PORT: String(assetPort), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 5000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); }); }); return child; }
async function stop(child) { if (child.exitCode !== null) return; child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
async function waitFor(predicate, message) { for (let index = 0; index < 100; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(message); }

test('workspace review routes preserve root documents and isolate review scope', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-review-http-workspace-')); const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-review-http-state-')); const serverPort = await port(); let assetPort = await port(); while (assetPort === serverPort) assetPort = await port(); let child;
  try {
    await writeFile(path.join(workspace, 'index.md'), '# Root document\n');
    for (const id of ['alpha', 'beta']) { await mkdir(path.join(workspace, id)); await writeFile(path.join(workspace, id, 'index.md'), `# ${id}\n`); await writeFile(path.join(workspace, id, 'status.md'), '# Status\n'); }
    child = await start(workspace, state, serverPort, assetPort);
    const overview = await request(serverPort, '/workspace/'); assert.equal(overview.status, 200); assert.match(overview.body, /ok-workbench-csrf/); assert.equal(overview.headers['cache-control'], 'no-store'); const csrf = overview.body.match(/name="ok-workbench-csrf" content="([^"]+)"/)?.[1]; assert.ok(csrf);
    const rootDocument = await request(serverPort, '/api/document?path=%2Fworkspace%2Findex.md'); assert.equal(rootDocument.status, 200); assert.equal(JSON.parse(rootDocument.body).text, '# Root document\n');
    const review = await request(serverPort, '/api/workspace-review'); assert.equal(review.status, 200); assert.equal(JSON.parse(review.body).review, null);
    const runOptions = { method: 'POST', headers: { 'x-ok-workbench-csrf': csrf } };
    const run = await request(serverPort, '/api/workspace-review/runs', { ...runOptions, body: '{}' }); assert.equal(run.status, 409); assert.equal(JSON.parse(run.body).code, 'NOT_CONFIGURED');
    const forced = await request(serverPort, '/api/workspace-review/runs', { ...runOptions, body: '{"force":true}' }); assert.equal(forced.status, 409); assert.equal(JSON.parse(forced.body).code, 'NOT_CONFIGURED');
    for (const body of ['{"unknown":true}', '{"force":"true"}']) { const invalid = await request(serverPort, '/api/workspace-review/runs', { ...runOptions, body }); assert.equal(invalid.status, 400); assert.equal(JSON.parse(invalid.body).code, 'INVALID_REQUEST'); }
    const strip = await request(serverPort, '/api/workspace-review/strip?projectId=alpha'); assert.equal(strip.status, 200); assert.equal(JSON.parse(strip.body).item, null);
    const traversal = await request(serverPort, '/api/workspace-review/reports?projectId=..'); assert.equal(traversal.status, 404);
  } finally { await stop(child); await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test('workspace review HTTP GET stays provider-free and both run bodies dispatch the staged pipeline', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-review-http-stub-workspace-')); const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-review-http-stub-state-')); const serverPort = await port(); let assetPort = await port(); while (assetPort === serverPort) assetPort = await port(); const providerPort = await port(); let child; const requests = [];
  const provider = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
      const user = body.messages?.at(-1)?.content || '{}'; const input = JSON.parse(user);
      let output;
      if (input.projectId) {
        const sourceId = input.sources[0].id;
        output = { assessment: { projectId: input.projectId, confidence: 'low', trajectory: 'unknown', lifecycle: 'unknown', outcome: 'Review current evidence', assessment: 'Evidence is available.', nextAction: null, blocker: null, cadence: 'weekly', cadenceReason: 'Weekly review.', evidenceIds: [sourceId], claimEvidence: [] }, attentionCandidates: [] };
      } else {
        const project = input.projects[0]; const sourceId = project.sources[0].id;
        output = { headline: 'Workspace review', summary: 'Current project evidence is available.', focusProjectId: null, evidenceIds: [sourceId], changes: [], priorities: input.projects.map((item, index) => ({ projectId: item.projectId, priority: 'maintain', rank: index + 1, priorityReason: 'Review current evidence.' })), attention: [], question: null };
      }
      const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload);
    });
  });
  await new Promise(resolve => provider.listen(providerPort, '127.0.0.1', resolve));
  try {
    await mkdir(path.join(workspace, 'alpha')); await writeFile(path.join(workspace, 'alpha', 'status.md'), '# Alpha\nEvidence.\n');
    child = await start(workspace, state, serverPort, assetPort, { LLM_COMPATIBLE_API_KEY: 'test-key', LLM_COMPATIBLE_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, LLM_COMPATIBLE_MODEL: 'fake-review-model' });
    const overview = await request(serverPort, '/workspace/'); const csrf = overview.body.match(/name="ok-workbench-csrf" content="([^"]+)"/)?.[1]; assert.ok(csrf);
    const options = { method: 'GET' }; await request(serverPort, '/api/workspace-review', options); assert.equal(requests.length, 0, 'GET does not dispatch provider work');
    const auth = { 'x-ok-workbench-csrf': csrf };
    const settings = await request(serverPort, '/api/workspace-review/settings', { method: 'PUT', headers: auth, body: JSON.stringify({ provider: 'compatible', model: 'fake-review-model', automatic: false, confirmations: { belowRecommendedModel: true }, expectedRevision: 0 }) }); assert.equal(settings.status, 200, settings.body);
    const run = await request(serverPort, '/api/workspace-review/runs', { method: 'POST', headers: auth, body: '{}' }); assert.equal(run.status, 202);
    await waitFor(() => requests.length >= 2, 'ordinary run did not issue project and synthesis provider calls');
    assert.equal(requests[0].max_tokens, 4096); assert.equal(requests[1].max_tokens, 16384);
    const countAfterOrdinary = requests.length; await request(serverPort, '/api/workspace-review', options); assert.equal(requests.length, countAfterOrdinary, 'GET remains provider-free after a briefing exists');
    await waitFor(async () => JSON.parse((await request(serverPort, '/api/workspace-review')).body).job?.state !== 'running', 'ordinary run did not finish before forced run');
    const forced = await request(serverPort, '/api/workspace-review/runs', { method: 'POST', headers: auth, body: '{"force":true}' }); assert.equal(forced.status, 202);
    await waitFor(() => requests.length >= countAfterOrdinary + 2, 'forced run did not issue project and synthesis provider calls');
  } finally { await stop(child); await new Promise(resolve => provider.close(resolve)); await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});
