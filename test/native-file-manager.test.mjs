import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createNativeFileManager } = require('../src/native-file-manager.js');

test('native launcher uses literal arguments without a shell', async () => {
  for (const [platform, target, directory, expected, mode] of [
    ['darwin', '/tmp/a "$(x)".md', false, ['/usr/bin/open', ['-R', '/tmp/a "$(x)".md']], 'reveal'],
    ['linux', '/tmp/a b/file.md', false, ['xdg-open', ['/tmp/a b']], 'open-directory'],
    ['linux', '/tmp/a b', true, ['xdg-open', ['/tmp/a b']], 'open-directory'],
    ['win32', 'C:\\work\\a,b.md', false, ['explorer.exe', ['/select,', 'C:\\work\\a,b.md']], 'reveal']
  ]) {
    let call;
    const manager = createNativeFileManager({ platform, env: { DISPLAY: ':0', PATH: '/bin' }, exists: () => true, spawnProcess(command, args, options) {
      call = [command, args]; assert.equal(options.shell, false); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); }); return child;
    } });
    assert.deepEqual(await manager.reveal(target, directory), { mode, launched: true }); assert.deepEqual(call, expected);
  }
});

test('native launcher rejects disabled, headless and failed launches', async () => {
  const disabled = createNativeFileManager({ platform: 'linux', env: { OK_WORKBENCH_NATIVE_FILE_MANAGER: '0' } });
  assert.equal(disabled.capability().available, false); await assert.rejects(disabled.reveal('/tmp/a', false), { code: 'NATIVE_UNAVAILABLE' });
  assert.equal(createNativeFileManager({ platform: 'linux', env: {} }).capability().available, false);
  const failed = createNativeFileManager({ platform: 'darwin', exists: () => true, spawnProcess() { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('no'))); return child; } });
  await assert.rejects(failed.reveal('/tmp/a', false), { code: 'NATIVE_LAUNCH_FAILED' });
  const exitFailure = createNativeFileManager({ platform: 'linux', env: { DISPLAY: ':0', PATH: '/bin' }, exists: () => true, spawnProcess() { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 2)); return child; } });
  await assert.rejects(exitFailure.reveal('/tmp/a', false), { code: 'NATIVE_LAUNCH_FAILED' });
  const timeout = createNativeFileManager({ platform: 'darwin', timeoutMs: 5, exists: () => true, spawnProcess() { const child = new EventEmitter(); child.kill = () => {}; return child; } });
  await assert.rejects(timeout.reveal('/tmp/a', false), { code: 'NATIVE_LAUNCH_FAILED' });
});
