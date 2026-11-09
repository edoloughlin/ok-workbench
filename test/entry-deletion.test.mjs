import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const { stageDeletion } = createRequire(import.meta.url)('../src/entry-deletion.js');

for (const failure of ['stage', 'index', 'rollback', 'cleanup']) {
  test(`deletion handles ${failure} failure without losing the recovery record`, async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'ok-delete-'));
    try {
      const target = path.join(root, 'draft.md'); const parentIndex = path.join(root, 'index.md');
      const recordDir = path.join(root, '.recovery'); const staged = path.join(recordDir, 'entry'); const temporary = path.join(root, '.temp');
      await fs.mkdir(recordDir); await fs.writeFile(path.join(recordDir, 'recovery.json'), '{}');
      await fs.writeFile(target, 'draft'); await fs.writeFile(parentIndex, 'before');
      const errors = [];
      const injected = { ...fs,
        async rename(from, to) {
          if (failure === 'stage' && from === target || failure === 'index' && from === temporary || failure === 'rollback' && (from === temporary || from === staged)) throw new Error('injected rename failure');
          return fs.rename(from, to);
        },
        async rm(file, options) { if (failure === 'cleanup' && file === staged) throw new Error('injected cleanup failure'); return fs.rm(file, options); }
      };
      const operation = stageDeletion({ target, parentIndex, recordDir, staged, temporary, original: 'before', updated: 'after', mode: 0o600, revalidate: async () => {}, log: (...args) => errors.push(args), fs: injected });
      if (failure === 'cleanup') {
        await operation; assert.equal(await fs.readFile(parentIndex, 'utf8'), 'after'); assert.equal(await fs.readFile(staged, 'utf8'), 'draft'); assert.equal(errors.length, 1);
      } else {
        await assert.rejects(operation, failure === 'rollback' ? { code: 'RECOVERY_REQUIRED' } : /injected/);
        assert.equal(await fs.readFile(parentIndex, 'utf8'), 'before');
        if (failure === 'rollback') { assert.equal(await fs.readFile(staged, 'utf8'), 'draft'); assert.equal(await fs.readFile(path.join(recordDir, 'recovery.json'), 'utf8'), '{}'); }
        else { assert.equal(await fs.readFile(target, 'utf8'), 'draft'); await assert.rejects(fs.stat(recordDir)); }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
