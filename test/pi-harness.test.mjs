import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('TurnWorker reports a sandbox process exit instead of leaving tool calls pending', async () => {
  const { TurnWorker } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const child = spawn(process.execPath, ['-e', "process.stderr.write('sandbox setup failed'); setTimeout(() => process.exit(17), 25)"] , { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  const worker = new TurnWorker(child);
  await assert.rejects(worker.call('list_files', {}), /Sandbox worker exited with status 17/);
});
