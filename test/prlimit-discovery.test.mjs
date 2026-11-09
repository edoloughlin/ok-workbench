import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { findPrlimit as findPythonPrlimit } from '../src/python-runner.mjs';

const require = createRequire(import.meta.url);
const { findPrlimit: findWorkerPrlimit } = require('../src/tool-worker.js');

for (const [name, find] of [['workspace tools', findWorkerPrlimit], ['Python', findPythonPrlimit]]) {
  test(`${name} discovers prlimit only in trusted system locations`, async () => {
    const checked = [];
    const access = async (candidate, mode) => { checked.push(candidate); assert.equal(mode, constants.X_OK); if (candidate !== '/run/current-system/sw/bin/prlimit') throw new Error('not present'); };
    assert.equal(await find(access), '/run/current-system/sw/bin/prlimit');
    assert.deepEqual(checked, ['/usr/bin/prlimit', '/run/current-system/sw/bin/prlimit']);
    assert.equal(await find(async () => {}), '/usr/bin/prlimit');
    await assert.rejects(find(async () => { throw new Error('not present'); }), /require(?:s)? prlimit/);
  });
}
