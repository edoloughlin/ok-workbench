import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('TurnWorker reports a sandbox process exit instead of leaving tool calls pending', async () => {
  const { TurnWorker } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const child = spawn(process.execPath, ['-e', "process.stderr.write('sandbox setup failed'); setTimeout(() => process.exit(17), 25)"] , { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  const worker = new TurnWorker(child);
  await assert.rejects(worker.call('list_files', {}), /Sandbox worker exited with status 17/);
});
test('TurnWorker reports unexpected sandbox exits to the backend logger', async () => {
  const { TurnWorker } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const exits = [];
  const child = spawn(process.execPath, ['-e', "process.stderr.write('sandbox diagnostic'); process.exit(23)"] , { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  const worker = new TurnWorker(child, { onUnexpectedExit: details => exits.push(details) });
  await assert.rejects(worker.call('list_files', {}), /status 23/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(exits.length, 1);
  assert.equal(typeof exits[0].pid, 'number');
  assert.equal(exits[0].code, 23);
  assert.equal(exits[0].signal, null);
  assert.match(exits[0].error, /status 23/);
});
test('sandbox backend selection and Seatbelt arguments are platform-specific', async () => {
  const { macosSandboxArgs, sandboxBackend, sandboxChildEnvironment } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  assert.equal(sandboxBackend('linux'), 'bubblewrap');
  assert.equal(sandboxBackend('darwin'), 'seatbelt');
  assert.equal(sandboxBackend('win32'), null);
  const args = macosSandboxArgs({
    workspace: '/Users/example/Work space', template: '/Applications/OK Workbench/template',
    temporaryDirectory: '/private/tmp/ok-workbench-worker-123', nodeBinary: '/opt/homebrew/Cellar/node/22.19.0/bin/node', workerSource: 'startWorker();',
  });
  assert.deepEqual(args.slice(0, 12), [
    '-D', 'WORKSPACE=/Users/example/Work space', '-D', 'TEMPLATE=/Applications/OK Workbench/template',
    '-D', 'PRIVATE_TMP=/private/tmp/ok-workbench-worker-123', '-D', 'NODE_BINARY=/opt/homebrew/Cellar/node/22.19.0/bin/node',
    '-D', 'NODE_RUNTIME=/opt/homebrew/Cellar/node/22.19.0', '-f', path.join(root, 'dist', 'macos-sandbox.sb'),
  ]);
  assert.deepEqual(args.slice(-4), ['/opt/homebrew/Cellar/node/22.19.0/bin/node', '--input-type=commonjs', '--eval', 'startWorker();']);
  const networkArgs = macosSandboxArgs({
    workspace: '/Users/example/Work space', template: '/Applications/OK Workbench/template',
    temporaryDirectory: '/private/tmp/ok-workbench-worker-123', nodeBinary: '/opt/homebrew/Cellar/node/22.19.0/bin/node', workerSource: 'startWorker();', network: true,
  });
  assert.ok(networkArgs.includes(path.join(root, 'dist', 'macos-network-sandbox.sb')));
  assert.deepEqual(sandboxChildEnvironment({
    platform: 'darwin', workspace: '/Users/example/Work space', template: '/Applications/OK Workbench/template', temporaryDirectory: '/private/tmp/ok-workbench-worker-123',
  }), {
    PATH: '/usr/bin:/bin', HOME: '/private/tmp/ok-workbench-worker-123', TMPDIR: '/private/tmp/ok-workbench-worker-123',
    OK_WORKSPACE_ROOT: '/Users/example/Work space', OKF_WORKSPACE_ROOT: '/Users/example/Work space', OK_WORKBENCH_PROJECT_TEMPLATE: '/Applications/OK Workbench/template', __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16)}:0:0`,
  });
  const profile = await readFile(path.join(root, 'dist', 'macos-sandbox.sb'), 'utf8');
  assert.match(profile, /^\(deny default\)$/m);
  assert.match(profile, /^\(deny network\*\)$/m);
  assert.doesNotMatch(profile, /\(allow network\*/);
  assert.match(profile, /\(literal "\/"\)/);
  assert.match(profile, /^\(allow process-info-pidinfo\)$/m);
  assert.match(profile, /global-name "com\.apple\.cfprefsd\.daemon"/);
  assert.match(profile, /global-name "com\.apple\.system\.opendirectoryd\.libinfo"/);
  assert.match(profile, /global-name "com\.apple\.diagnosticd"/);
  assert.match(profile, /global-name "com\.apple\.logd"/);
  assert.match(profile, /\(allow file-ioctl \(literal "\/dev\/dtracehelper"\)\)/);
  assert.match(profile, /ipc-posix-name "apple\.shm\.notification_center"/);
  assert.match(profile, /\(allow file-write-data[\s\S]*\(literal "\/dev\/null"\)/);
});
test('TurnWorker waits for an explicit sandbox-ready acknowledgement', async () => {
  const { TurnWorker } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  const worker = new TurnWorker(child);
  const ready = worker.waitForReady(1_000);
  worker.read('{"ready":true}\n');
  await ready;
  worker.close();
});
test('macOS Seatbelt worker can service workspace tools', { skip: process.platform !== 'darwin' }, async () => {
  const { createTurnWorker } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-seatbelt-'));
  await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
  await writeFile(path.join(workspace, 'note.md'), 'sandboxed\n');
  const worker = await createTurnWorker(workspace);
  assert.ok(worker, 'sandbox-exec must be available on macOS');
  try {
    assert.deepEqual(await worker.call('read_file', { path: 'note.md' }), { path: 'note.md', content: 'sandboxed\n' });
  } finally {
    worker.close();
  }
});
test('project tool result preserves the Pi tool-result envelope and creation metadata', async () => {
  const { projectToolResult } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const base = { content: [{ type: 'text', text: '{"id":"planning"}' }], details: { result: { id: 'planning', location: '/workspace/planning' } } };
  const result = projectToolResult(base, { initialized: true, repository: '/tmp/workspace' });
  assert.deepEqual(result.details.result, { id: 'planning', location: '/workspace/planning', git: { initialized: true, repository: '/tmp/workspace' } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details.result);
});
test('workspace AGENTS.md is included as bounded system instructions', async () => {
  const { workspaceAgentInstructions } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-instructions-'));
  const project = path.join(workspace, 'project');
  await writeFile(path.join(workspace, 'AGENTS.md'), '# Workspace rules\n\nAlways preserve evidence.\n');
  await (await import('node:fs/promises')).mkdir(project);
  await writeFile(path.join(project, 'AGENTS.md'), '# Project rules\n\nKeep project notes current.\n');
  const instructions = await workspaceAgentInstructions(workspace, project);
  assert.match(instructions, /\[Workspace instructions: AGENTS\.md\][\s\S]*Always preserve evidence/);
  assert.match(instructions, /\[Project instructions: AGENTS\.md\][\s\S]*Keep project notes current/);
  assert.ok(instructions.indexOf('Always preserve evidence') < instructions.indexOf('Keep project notes current'));
});
