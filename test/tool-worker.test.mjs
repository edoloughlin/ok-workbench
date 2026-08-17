import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const worker = createRequire(import.meta.url)(path.join(root, 'dist', 'tool-worker.js'));
test('worker rejects traversal, private names, and symlink escapes while allowing scoped edits', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-worker-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ok-workbench-outside-'));
  await writeFile(path.join(workspace, 'note.md'), 'hello\n');
  await writeFile(path.join(outside, 'private.md'), 'private\n');
  await symlink(path.join(outside, 'private.md'), path.join(workspace, 'escape.md'));
  await symlink(outside, path.join(workspace, 'outside'));
  worker.setWorkspaceRoot(workspace);
  await assert.rejects(worker.readFile('../private.md'));
  await assert.rejects(worker.readFile('.env'));
  await assert.rejects(worker.readFile('escape.md'));
  await assert.rejects(worker.applyPatch({ path: 'outside/new.md', content: 'nope' }));
  await worker.applyPatch({ path: 'notes/new.md', content: 'safe' });
  assert.equal(await readFile(path.join(workspace, 'notes', 'new.md'), 'utf8'), 'safe');
});
test('worker creates and registers a discoverable top-level project', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-project-'));
  const template = await mkdtemp(path.join(tmpdir(), 'ok-workbench-template-'));
  await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
  await cp(path.join(root, 'seed', 'workspace', 'templates', 'project'), template, { recursive: true });
  const savedTemplate = process.env.OK_WORKBENCH_PROJECT_TEMPLATE; process.env.OK_WORKBENCH_PROJECT_TEMPLATE = template;
  worker.setWorkspaceRoot(workspace);
  try {
    const created = await worker.createProject({ id: 'planning', title: 'Private planning' });
    assert.deepEqual(created, { id: 'planning', path: 'planning', location: '/workspace/planning', title: 'Private planning', structure: 'OKF 0.2 project template' });
    assert.match(await readFile(path.join(workspace, 'planning', 'index.md'), 'utf8'), /type: Project/);
    assert.match(await readFile(path.join(workspace, 'planning', 'index.md'), 'utf8'), /# Private planning/);
    assert.match(await readFile(path.join(workspace, 'planning', 'status.md'), 'utf8'), /title: Private planning status/);
    assert.match(await readFile(path.join(workspace, 'index.md'), 'utf8'), /- \[Private planning\]\(planning\/\)/);
    await assert.rejects(worker.createProject({ id: 'planning' }), /already exists/);
    await assert.rejects(worker.createProject({ id: '../outside' }), /Project ID/);
    await assert.rejects(worker.applyProjectUpdate({ changes: [{ path: 'planning/brief.md', content: '# Brief\n' }] }), /requires planning\/index.md/);
    const index = await readFile(path.join(workspace, 'planning', 'index.md'), 'utf8');
    const log = await readFile(path.join(workspace, 'planning', 'log.md'), 'utf8');
    const status = await readFile(path.join(workspace, 'planning', 'status.md'), 'utf8');
    await assert.rejects(worker.applyProjectUpdate({ changes: [
      { path: 'planning/index.md', content: index }, { path: 'planning/log.md', content: log }, { path: 'planning/status.md', content: status }, { path: 'planning/references/note.md', content: 'evidence\n' }
    ] }), /New directory planning\/references requires planning\/references\/index.md/);
    const update = await worker.applyProjectUpdate({ changes: [
      { path: 'planning/index.md', content: `${index}\n* [Evidence](references/index.md)\n` },
      { path: 'planning/log.md', content: `${log}\n## 2026-08-17\n\n- Added initial evidence.\n` },
      { path: 'planning/status.md', content: status.replace('No substantive work recorded yet.', 'Added initial evidence.') },
      { path: 'planning/references/index.md', content: '# References\n\n* [Evidence note](note.md)\n' },
      { path: 'planning/references/note.md', content: 'evidence\n' }
    ] });
    assert.deepEqual(update.paths, ['planning/index.md', 'planning/log.md', 'planning/status.md', 'planning/references/index.md', 'planning/references/note.md']);
  } finally { if (savedTemplate === undefined) delete process.env.OK_WORKBENCH_PROJECT_TEMPLATE; else process.env.OK_WORKBENCH_PROJECT_TEMPLATE = savedTemplate; }
});
