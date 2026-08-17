import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
test('server serves an arbitrary bundle, redirects legacy routes, and rejects escaping symlinks', { skip: !process.env.OK_WORKBENCH_INTEGRATION }, async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'ok-workbench-server-'));
  const workspace = path.join(repository, 'workspace');
  const sibling = path.join(repository, 'sibling');
  const git = (...args) => { const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await (await import('node:fs/promises')).mkdir(workspace); await (await import('node:fs/promises')).mkdir(sibling);
  const outside = path.join(tmpdir(), `ok-workbench-outside-${process.pid}.md`);
  await writeFile(path.join(workspace, 'index.md'), '# Test workspace\n');
  await writeFile(path.join(workspace, 'tracked.md'), 'before\n'); await writeFile(path.join(sibling, 'tracked.md'), 'before\n');
  await writeFile(outside, 'private\n');
  await symlink(outside, path.join(workspace, 'escape.md'));
  git('add', '.'); git('commit', '-m', 'baseline');
  const port = 38517;
  const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], { env: { ...process.env, OKF_WORKSPACE_ROOT: workspace, PORT: String(port) } });
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 5000); child.stdout?.on('data', () => { clearTimeout(timer); resolve(); }); child.on('error', reject); child.on('exit', code => reject(new Error(`server exited ${code}`))); });
    const document = await fetch(`http://127.0.0.1:${port}/api/document?path=/workspace/index.md`);
    assert.equal(document.status, 200); assert.equal((await document.json()).title, 'Test workspace');
    const escaped = await fetch(`http://127.0.0.1:${port}/api/document?path=/workspace/escape.md`);
    assert.equal(escaped.status, 404);
    const legacy = await fetch(`http://127.0.0.1:${port}/agents/`, { redirect: 'manual' });
    assert.equal(legacy.status, 308); assert.equal(legacy.headers.get('location'), '/workspace/');
    await writeFile(path.join(workspace, 'tracked.md'), 'workspace edit\n');
    await writeFile(path.join(sibling, 'tracked.md'), 'sibling edit\n');
    const status = await fetch(`http://127.0.0.1:${port}/api/projects/workspace/git/status`);
    const statusBody = await status.json(); assert.ok(statusBody.files.some(file => /workspace\/tracked\.md$/.test(file.path))); assert.ok(statusBody.files.every(file => !file.path.includes('sibling/')));
    const diff = await fetch(`http://127.0.0.1:${port}/api/projects/workspace/git/diff?source=unstaged`);
    const diffBody = await diff.json(); assert.match(diffBody.patch, /workspace edit/); assert.doesNotMatch(diffBody.patch, /sibling edit/);
    const page = await fetch(`http://127.0.0.1:${port}/workspace/`); const csrf = (await page.text()).match(/name="ok-workbench-csrf" content="([^"]+)"/)?.[1]; assert.ok(csrf);
    const revert = await fetch(`http://127.0.0.1:${port}/api/projects/workspace/git/revert`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf }, body: JSON.stringify({ token: diffBody.token }) });
    assert.equal(revert.status, 200); assert.equal(await readFile(path.join(workspace, 'tracked.md'), 'utf8'), 'before\n'); assert.equal(await readFile(path.join(sibling, 'tracked.md'), 'utf8'), 'sibling edit\n');
  } finally { child.kill(); }
});
