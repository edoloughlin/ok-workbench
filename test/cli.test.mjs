import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'dist', 'bin', 'ok-workbench.mjs');
test('init creates the complete seed and never overwrites a user file', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'ok-workbench-'));
  const options = { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } };
  let result = spawnSync(process.execPath, [cli, 'init', target, '--yes'], options);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(target, 'index.md'), 'utf8'), /Workspace bundle/);
  assert.match(await readFile(path.join(target, 'workflow', 'index.md'), 'utf8'), /orient/);
  await writeFile(path.join(target, 'index.md'), '# Mine\n');
  result = spawnSync(process.execPath, [cli, 'init', target, '--yes'], options);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(target, 'index.md'), 'utf8'), '# Mine\n');
  result = spawnSync(process.execPath, [cli, 'init', target, '--yes', '--merge'], options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(target, 'index.md'), 'utf8'), '# Mine\n');
});
test('init refuses the filesystem root', () => {
  const result = spawnSync(process.execPath, [cli, 'init', '/', '--yes'], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.notEqual(result.status, 0);
});
test('doctor uses the saved workspace root when no explicit root is supplied', async () => {
  const configHome = await mkdtemp(path.join(tmpdir(), 'ok-workbench-config-'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-workspace-'));
  await mkdir(path.join(configHome, 'ok-workbench'));
  await writeFile(path.join(configHome, 'ok-workbench', 'config.json'), JSON.stringify({ workspaceRoot: workspace }));
  const result = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: configHome, NODE_TEST_CONTEXT: '' } });
  assert.equal(result.status, 0, result.stderr);
});
test('seed diff reports user edits without changing the workspace', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'ok-workbench-seed-diff-'));
  const options = { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } };
  assert.equal(spawnSync(process.execPath, [cli, 'init', target, '--yes'], options).status, 0);
  await writeFile(path.join(target, 'workflow', 'orient.md'), '# My workflow\n');
  const result = spawnSync(process.execPath, [cli, 'seed', 'diff', target], options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(target, 'workflow', 'orient.md'), 'utf8'), '# My workflow\n');
});
test('merge reports a file-versus-directory conflict without overwriting it', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'ok-workbench-conflict-'));
  const options = { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } };
  await writeFile(path.join(target, 'workflow'), 'user file\n');
  let result = spawnSync(process.execPath, [cli, 'init', target, '--yes'], options);
  assert.notEqual(result.status, 0);
  result = spawnSync(process.execPath, [cli, 'init', target, '--yes', '--merge'], options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(target, 'workflow'), 'utf8'), 'user file\n');
  assert.match(await readFile(path.join(target, 'index.md'), 'utf8'), /Workspace bundle/);
});
