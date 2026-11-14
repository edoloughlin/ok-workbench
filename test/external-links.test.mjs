import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const externalLinks = require('../src/external-links.js');
const worker = require('../src/tool-worker.js');

test('approved external directory snapshots expose only eligible files through its alias', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-external-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ok-workbench-external-source-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-external-state-'));
  const project = path.join(workspace, 'alpha'); await mkdir(project);
  await writeFile(path.join(outside, 'guide.md'), '# Guide\n'); await mkdir(path.join(outside, 'nested'));
  await writeFile(path.join(outside, 'nested', 'note.md'), 'note\n'); await writeFile(path.join(outside, '.env'), 'secret\n');
  await symlink(outside, path.join(project, 'reference'));
  try {
    const inspection = await externalLinks.inspectLink({ workspaceRoot: workspace, projectRoot: project, linkPath: 'reference', deniedRoots: [state] });
    const grant = await externalLinks.approveGrant(state, inspection);
    assert.equal(grant.kind, 'directory');
    assert.equal((await externalLinks.listGrants(state, workspace, project, { deniedRoots: [state] }))[0].status, 'approved');
    const active = await externalLinks.activeGrants(state, workspace, project, { deniedRoots: [state] });
    const snapshot = await externalLinks.stageExternalGrants(active);
    try {
      assert.equal(await readFile(path.join(snapshot.staged.reference.snapshotPath, 'guide.md'), 'utf8'), '# Guide\n');
      await assert.rejects(readFile(path.join(snapshot.staged.reference.snapshotPath, '.env'), 'utf8'));
      worker.setWorkspaceRoot(project, { externalReadGrants: snapshot.staged });
      const guide = await worker.readFile('reference/guide.md'); assert.equal(guide.content, '# Guide\n');
      assert.deepEqual(await worker.listFiles('reference'), ['reference/guide.md', 'reference/nested/note.md']);
      assert.deepEqual(await worker.searchFiles('note'), [{ path: 'reference/nested/note.md', line: 1, text: 'note' }]);
      await assert.rejects(worker.editFile({ path: 'reference/guide.md', hash: guide.hash, edits: [{ startLine: 1, endLine: 1, replacement: 'changed' }] }), /read-only/);
    } finally { await rm(snapshot.directory, { recursive: true, force: true }); }
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test('navigation enumerates filtered metadata deterministically and fails without partial output', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'ok-nav-source-'));
  try {
    await mkdir(path.join(outside, 'docs')); await mkdir(path.join(outside, 'node_modules'));
    await writeFile(path.join(outside, 'docs', 'index.md'), '# Not navigation metadata');
    await writeFile(path.join(outside, 'z.md'), 'z'); await writeFile(path.join(outside, '.env'), 'secret');
    await link(path.join(outside, 'z.md'), path.join(outside, 'hard.md'));
    await symlink(path.join(outside, 'docs'), path.join(outside, 'nested'));
    const grant = { canonicalTarget: outside };
    const result = await externalLinks.navigationChildren(grant, '/workspace/alpha/ref', async () => true);
    assert.deepEqual(result.map(item => item.label), ['docs']);
    assert.deepEqual(result[0].children.map(item => item.label), ['index.md']);
    assert.equal(result[0].children[0].path, '/workspace/alpha/ref/docs/index.md');
    const sharedBudget = { entries: 9999 };
    await assert.rejects(externalLinks.navigationChildren(grant, '/alias', async () => true, sharedBudget), { code: 'EXTERNAL_LIMIT_EXCEEDED' });
    assert.equal(sharedBudget.entries, 9999, 'a failed grant must not consume another grant\'s navigation budget');
    const small = await mkdtemp(path.join(tmpdir(), 'ok-nav-small-'));
    try {
      await writeFile(path.join(small, 'after.md'), 'after');
      const later = await externalLinks.navigationChildren({ canonicalTarget: small }, '/workspace/alpha/later', async () => true, sharedBudget);
      assert.deepEqual(later.map(item => item.label), ['after.md']);
      assert.equal(sharedBudget.entries, 10000);
    } finally { await rm(small, { recursive: true, force: true }); }
    await assert.rejects(externalLinks.navigationChildren(grant, '/alias', async () => { throw new Error('injected'); }), /injected/);
    let deep = outside;
    for (let i = 0; i < 13; i++) { deep = path.join(deep, `d${i}`); await mkdir(deep); }
    await assert.rejects(externalLinks.navigationChildren(grant, '/alias', async () => true), { code: 'EXTERNAL_LIMIT_EXCEEDED' });
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test('retargeted or nested external symlinks do not retain approval', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-external-binding-'));
  const first = await mkdtemp(path.join(tmpdir(), 'ok-workbench-external-first-'));
  const second = await mkdtemp(path.join(tmpdir(), 'ok-workbench-external-second-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-external-binding-state-'));
  const project = path.join(workspace, 'alpha'); await mkdir(project); await writeFile(path.join(first, 'one.md'), 'one'); await writeFile(path.join(second, 'two.md'), 'two');
  await symlink(first, path.join(project, 'reference'));
  try {
    const approved = await externalLinks.approveGrant(state, await externalLinks.inspectLink({ workspaceRoot: workspace, projectRoot: project, linkPath: 'reference', deniedRoots: [state] }));
    await rm(path.join(project, 'reference')); await symlink(second, path.join(project, 'reference'));
    assert.equal((await externalLinks.listGrants(state, workspace, project, { deniedRoots: [state] }))[0].status, 'changed');
    assert.equal((await externalLinks.activeGrants(state, workspace, project, { deniedRoots: [state] })).length, 0);
    await symlink(path.join(second, 'two.md'), path.join(second, 'nested-link.md'));
    const snapshot = await externalLinks.stageExternalGrants([{ ...approved, canonicalTarget: second, linkText: second }]);
    try { await assert.rejects(readFile(path.join(snapshot.staged.reference.snapshotPath, 'nested-link.md'))); }
    finally { await rm(snapshot.directory, { recursive: true, force: true }); }
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});
