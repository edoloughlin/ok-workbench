import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
test('chat UI exposes the GitHub Copilot device code outside transient status text', async () => {
  const [html, script, server] = await Promise.all([
    readFile(path.join(root, 'src', 'public', 'index.html'), 'utf8'),
    readFile(path.join(root, 'src', 'public', 'app.js'), 'utf8'),
    readFile(path.join(root, 'src', 'server.js'), 'utf8'),
  ]);
  assert.match(html, /id="chat-copilot-login"/);
  assert.match(html, /id="chat-auth-code"/);
  assert.match(html, /id="chat-auth-dialog-code"/);
  assert.match(html, /id="todo-popover"/);
  assert.match(script, /showAuthenticationCode\(provider, label, data\.user_code\)/);
  assert.match(script, /chatUi\.authDialog\.showModal\(\)/);
  assert.match(script, /Loading workspace…/);
  assert.match(script, /Loading chat history…/);
  assert.match(script, /while \(i < lines\.length && lines\[i\]\.trim\(\) && !blockBoundary\(lines\[i\]\)\)/);
  assert.match(script, /'~': \{ name: 'In progress'/);
  assert.match(script, /data-task-start-line/);
  assert.match(script, /function renderUserMarkdown\(element, content\)/);
  assert.match(script, /renderChatMarkdown\(element, content, '\/workspace\/index\.md'\)/);
  assert.match(script, /encodeURIComponent\(decodeURIComponent\(part\)\)/);
  assert.match(html, /Check side effects with LLM/);
  assert.match(html, /id="todo-use-llm" type="checkbox" checked/);
  assert.match(script, /Briefly check this project for related side effects/);
  assert.match(server, /event\.userCode \|\| event\.user_code/);
  assert.match(server, /openai-codex\|github-copilot/);
  assert.match(server, /workspace-relative Markdown paths/);
});
test('server serves an arbitrary bundle, redirects legacy routes, and rejects escaping symlinks', { skip: !process.env.OK_WORKBENCH_INTEGRATION }, async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'ok-workbench-server-'));
  const workspace = path.join(repository, 'workspace');
  const sibling = path.join(repository, 'sibling');
  const git = (...args) => { const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await mkdir(workspace); await mkdir(sibling); await mkdir(path.join(workspace, 'linked-project')); await mkdir(path.join(workspace, 'unlisted-project')); await mkdir(path.join(workspace, 'bare-project'));
  const outside = path.join(tmpdir(), `ok-workbench-outside-${process.pid}.md`);
  await writeFile(path.join(workspace, 'index.md'), '# Test workspace\n\n- [Linked project](linked-project/index.md)\n* [ ] Direct task\n');
  await writeFile(path.join(workspace, 'linked-project', 'index.md'), '# Linked project\n');
  await writeFile(path.join(workspace, 'linked-project', 'status.md'), '# Status\n'); await writeFile(path.join(workspace, 'linked-project', 'log.md'), '# Log\n');
  await writeFile(path.join(workspace, 'unlisted-project', 'index.md'), '# Unlisted project\n');
  await writeFile(path.join(workspace, 'unlisted-project', 'status.md'), '# Status\n'); await writeFile(path.join(workspace, 'unlisted-project', 'log.md'), '# Log\n');
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
    const project = await fetch(`http://127.0.0.1:${port}/api/project?path=/workspace/`);
    const projectBody = await project.json(); assert.ok(projectBody.projects.some(item => item.name === 'linked-project' && item.path === '/workspace/linked-project')); assert.ok(projectBody.projects.some(item => item.name === 'unlisted-project' && item.path === '/workspace/unlisted-project')); assert.ok(projectBody.projects.some(item => item.name === 'bare-project' && item.path === '/workspace/bare-project'));
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
    const todo = await fetch(`http://127.0.0.1:${port}/api/projects/workspace/todos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf }, body: JSON.stringify({ path: '/workspace/index.md', startLine: 4, endLine: 4, original: '* [ ] Direct task', replacement: '* [x] Direct task' }) });
    assert.equal(todo.status, 200); assert.match(await readFile(path.join(workspace, 'index.md'), 'utf8'), /\* \[x\] Direct task/);
  } finally { child.kill(); }
});
