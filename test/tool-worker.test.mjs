import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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
