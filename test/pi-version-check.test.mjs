import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createPiVersionChecker } = require('../src/pi-version-check.js');

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ok-workbench-pi-version-'));
  const packageFile = path.join(stateDir, 'package.json');
  await writeFile(packageFile, JSON.stringify({ version: '1.1.0' }));
  try { await run({ stateDir, packageFile }); }
  finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('checks npm once per day, persists the result, and notices a newer Pi runtime', async () => fixture(async ({ stateDir, packageFile }) => {
  let timestamp = 1_000_000_000; let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://registry.npmjs.org/@earendil-works%2Fpi-ai/latest');
    assert.equal(options.headers.accept, 'application/json');
    return { ok: true, json: async () => ({ version: calls === 1 ? '1.2.0' : '1.1.0' }) };
  };
  const options = { stateDir, packageFile, fetchImpl, now: () => timestamp };
  const checker = createPiVersionChecker(options);
  const [first, simultaneous] = await Promise.all([checker.check(), checker.check()]);
  assert.deepEqual(first, simultaneous);
  assert.deepEqual(first, { installed: '1.1.0', latest: '1.2.0', updateAvailable: true, checkedAt: timestamp });
  assert.equal((await createPiVersionChecker(options).check()).latest, '1.2.0');
  assert.equal(calls, 1);
  timestamp += 24 * 60 * 60 * 1000;
  assert.deepEqual(await checker.check(), { installed: '1.1.0', latest: '1.1.0', updateAvailable: false, checkedAt: timestamp });
  assert.equal(calls, 2);
}));

test('invalid responses and offline registry do not produce false update warnings', async () => fixture(async ({ stateDir, packageFile }) => {
  let timestamp = 1_000_000_000; let calls = 0;
  const checker = createPiVersionChecker({ stateDir, packageFile, now: () => timestamp, fetchImpl: async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ version: '<unsafe>' }) };
    throw new Error('offline');
  } });
  assert.deepEqual(await checker.check(), { installed: '1.1.0', latest: null, updateAvailable: false, checkedAt: timestamp });
  assert.equal((await checker.check()).latest, null);
  assert.equal(calls, 1);
  timestamp += 24 * 60 * 60 * 1000;
  assert.equal((await checker.check()).latest, null);
  assert.equal(calls, 2);
}));
