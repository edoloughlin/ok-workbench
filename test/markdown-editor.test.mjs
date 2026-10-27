import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitForServer(base, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/workspace/`);
      if (response.ok) return await response.text();
    } catch { /* Server not listening yet. */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Server did not start');
}

test('Markdown editing checks CSRF, revision, path and writes exact source', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-workbench-markdown-'));
  const workspace = path.join(tmp, 'workspace');
  await fs.mkdir(path.join(workspace, 'demo'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
  await fs.writeFile(path.join(workspace, 'demo', 'index.md'), '# Demo\n');
  await fs.writeFile(path.join(workspace, 'demo', 'note.md'), '---\ntitle: Example\n---\n\n# Original\n');
  await fs.writeFile(path.join(tmp, 'outside.md'), '# Outside\n');
  await fs.symlink(path.join(tmp, 'outside.md'), path.join(workspace, 'demo', 'linked.md'));
  const port = await freePort();
  let assetPort = await freePort();
  while (assetPort === port) assetPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), OK_WORKBENCH_ASSET_PORT: String(assetPort), OK_WORKSPACE_ROOT: workspace,
      OK_WORKBENCH_STATE_DIR: path.join(tmp, 'state') }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const html = await waitForServer(base, child);
  const csrf = html.match(/name="ok-workbench-csrf" content="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const route = '/workspace/demo/note.md';
  const document = async (file = route) => {
    const response = await fetch(`${base}/api/document?path=${encodeURIComponent(file)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const save = (body, token = csrf) => fetch(`${base}/api/document`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-ok-workbench-csrf': token }, body: JSON.stringify(body)
  });
  const original = await document();
  assert.equal(original.editable, true);
  assert.match(original.revision, /^[a-f0-9]{64}$/);
  const text = '---\ntitle: Example\n---\n\n# Edited\n';
  let response = await save({ path: route, revision: original.revision, text }, 'wrong');
  assert.equal(response.status, 400);
  response = await save({ path: route, revision: original.revision, text });
  assert.equal(response.status, 200);
  assert.equal(await fs.readFile(path.join(workspace, 'demo', 'note.md'), 'utf8'), text);
  const updated = await response.json();
  assert.notEqual(updated.revision, original.revision);
  response = await save({ path: route, revision: original.revision, text: '# Overwrite\n' });
  assert.equal(response.status, 409);
  assert.equal(await fs.readFile(path.join(workspace, 'demo', 'note.md'), 'utf8'), text);
  response = await save({ path: '/workspace/demo/linked.md', revision: updated.revision, text: '# Changed\n' });
  assert.equal(response.status, 400);
  assert.equal(await fs.readFile(path.join(tmp, 'outside.md'), 'utf8'), '# Outside\n');
  response = await save({ path: '/workspace/demo/../note.md', revision: updated.revision, text: '# Invalid\n' });
  assert.equal(response.status, 400);
  response = await save({ path: route, revision: updated.revision, text: '\0' });
  assert.equal(response.status, 400);
  // An external write after the page was loaded must not be lost.
  const latest = await document();
  await fs.writeFile(path.join(workspace, 'demo', 'note.md'), '# External edit\n');
  response = await save({ path: route, revision: latest.revision, text: '# Conflict\n' });
  assert.equal(response.status, 409);
  assert.equal(await fs.readFile(path.join(workspace, 'demo', 'note.md'), 'utf8'), '# External edit\n');
});
