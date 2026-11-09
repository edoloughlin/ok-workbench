import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const sandbox = process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/usr/bin/true']).status === 0;
test('Pi harness registers and executes web fetch in project and workspace modes but not zero-tool mode', { skip: !sandbox }, () => {
  const result = spawnSync(process.execPath, ['--experimental-loader', path.resolve('test/fixtures/web-fetch/pi-loader.mjs'), path.resolve('test/fixtures/web-fetch/pi-harness-check.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PI_OFFLINE: '1' } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
