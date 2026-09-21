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
async function start(workspace, state, serverPort, assetPort) { const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], { env: { ...process.env, OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(serverPort), OK_WORKBENCH_ASSET_PORT: String(assetPort) }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 5000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); }); }); return child; }
async function stop(child) { if (child.exitCode !== null) return; child.kill(); await new Promise(resolve => child.once('exit', resolve)); }

test('workspace review routes preserve root documents and isolate review scope', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-review-http-workspace-')); const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-review-http-state-')); const serverPort = await port(); let assetPort = await port(); while (assetPort === serverPort) assetPort = await port(); let child;
  try {
    await writeFile(path.join(workspace, 'index.md'), '# Root document\n');
    for (const id of ['alpha', 'beta']) { await mkdir(path.join(workspace, id)); await writeFile(path.join(workspace, id, 'index.md'), `# ${id}\n`); await writeFile(path.join(workspace, id, 'status.md'), '# Status\n'); }
    child = await start(workspace, state, serverPort, assetPort);
    const overview = await request(serverPort, '/workspace/'); assert.equal(overview.status, 200); assert.match(overview.body, /ok-workbench-csrf/); assert.equal(overview.headers['cache-control'], 'no-store'); const csrf = overview.body.match(/name="ok-workbench-csrf" content="([^"]+)"/)?.[1]; assert.ok(csrf);
    const rootDocument = await request(serverPort, '/api/document?path=%2Fworkspace%2Findex.md'); assert.equal(rootDocument.status, 200); assert.equal(JSON.parse(rootDocument.body).text, '# Root document\n');
    const review = await request(serverPort, '/api/workspace-review'); assert.equal(review.status, 200); assert.equal(JSON.parse(review.body).review, null);
    const run = await request(serverPort, '/api/workspace-review/runs', { method: 'POST', body: '{}', headers: { 'x-ok-workbench-csrf': csrf } }); assert.equal(run.status, 409); assert.equal(JSON.parse(run.body).code, 'NOT_CONFIGURED');
    const strip = await request(serverPort, '/api/workspace-review/strip?projectId=alpha'); assert.equal(strip.status, 200); assert.equal(JSON.parse(strip.body).item, null);
    const traversal = await request(serverPort, '/api/workspace-review/reports?projectId=..'); assert.equal(traversal.status, 404);
  } finally { await stop(child); await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});
