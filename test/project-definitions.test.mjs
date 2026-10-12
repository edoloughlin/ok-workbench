import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const { findProjectDefinition } = createRequire(import.meta.url)('../src/project-definitions.js');

test('search stays in the project, prefers root then shallow directories then archives, and reports duplicates', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'definition-search-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'project');
  await mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
  await mkdir(path.join(root, 'archive'), { recursive: true });
  await mkdir(path.join(workspace, 'other'));
  const md = (key, definition) => `| ID | Meaning |\n|----|---------|\n| ${key} | ${definition} |\n`;
  await writeFile(path.join(root, 'current.md'), 'See WC-1 and MOD-1.');
  await writeFile(path.join(root, 'root.md'), md('WC-1', 'Root wins.'));
  await writeFile(path.join(root, 'nested', 'near.md'), md('WC-1', 'Nested loses.') + md('MOD-1', 'Near wins.'));
  await writeFile(path.join(root, 'nested', 'deep', 'far.md'), md('MOD-1', 'Far loses.'));
  await writeFile(path.join(root, 'archive', 'old.md'), md('WC-1', 'Archive loses.') + md('ARCH-1', 'Archived.'));
  await writeFile(path.join(workspace, 'other', 'secret.md'), md('PRIVATE-1', 'Not visible.'));
  await symlink(path.join(workspace, 'other'), path.join(root, 'linked'));
  const current = path.join(root, 'current.md');
  assert.deepEqual(await findProjectDefinition(root, current, 'WC-1'), { definition: 'Root wins.', file: 'root.md', multiple: true });
  assert.deepEqual(await findProjectDefinition(root, current, 'MOD-1'), { definition: 'Near wins.', file: 'nested/near.md', multiple: true });
  assert.deepEqual(await findProjectDefinition(root, current, 'ARCH-1'), { definition: 'Archived.', file: 'archive/old.md', multiple: false });
  assert.equal(await findProjectDefinition(root, current, 'PRIVATE-1'), null);
  // A different key uses the same index; file edits and additions invalidate it.
  await writeFile(path.join(root, 'root.md'), md('WC-1', 'Edited definition.'));
  await writeFile(path.join(root, 'new.md'), md('PRIVATE-1', 'New definition.'));
  async function eventually(lookup, expected) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await lookup() === expected) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await lookup(), expected);
  }
  await eventually(async () => (await findProjectDefinition(root, current, 'WC-1'))?.definition, 'Edited definition.');
  await eventually(async () => (await findProjectDefinition(root, current, 'PRIVATE-1'))?.definition, 'New definition.');
});
