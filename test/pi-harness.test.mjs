import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const linuxSandboxAvailable = process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/usr/bin/true']).status === 0;

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
    temporaryDirectory: '/private/tmp/ok-workbench-worker-123', grants: '/private/tmp/ok-workbench-grants-123', nodeBinary: '/opt/homebrew/Cellar/node/22.19.0/bin/node', workerSource: 'startWorker();',
  });
  assert.deepEqual(args.slice(0, 14), [
    '-D', 'WORKSPACE=/Users/example/Work space', '-D', 'TEMPLATE=/Applications/OK Workbench/template',
    '-D', 'PRIVATE_TMP=/private/tmp/ok-workbench-worker-123', '-D', 'GRANTS=/private/tmp/ok-workbench-grants-123', '-D', 'NODE_BINARY=/opt/homebrew/Cellar/node/22.19.0/bin/node',
    '-D', 'NODE_RUNTIME=/opt/homebrew/Cellar/node/22.19.0', '-f', path.join(root, 'dist', 'macos-sandbox.sb'),
  ]);
  assert.deepEqual(args.slice(-4), ['/opt/homebrew/Cellar/node/22.19.0/bin/node', '--input-type=commonjs', '--eval', 'startWorker();']);
  assert.ok(!args.includes(path.join(root, 'dist', 'macos-network-sandbox.sb')));
  assert.deepEqual(sandboxChildEnvironment({
    platform: 'darwin', workspace: '/Users/example/Work space', template: '/Applications/OK Workbench/template', temporaryDirectory: '/private/tmp/ok-workbench-worker-123', grants: '/private/tmp/ok-workbench-grants-123',
  }), {
    PATH: '/usr/bin:/bin', HOME: '/private/tmp/ok-workbench-worker-123', TMPDIR: '/private/tmp/ok-workbench-worker-123',
    OK_WORKSPACE_ROOT: '/Users/example/Work space', OKF_WORKSPACE_ROOT: '/Users/example/Work space', OK_WORKBENCH_PROJECT_TEMPLATE: '/Applications/OK Workbench/template', OK_WORKBENCH_WORKSPACE_MODE: '0', OK_WORKBENCH_READ_GRANTS: '{}', OK_WORKBENCH_EXTERNAL_READ_GRANTS: '{}', __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16)}:0:0`,
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
    assert.deepEqual(await worker.call('read_file', { path: 'note.md' }), { path: 'note.md', content: 'sandboxed\n', hash: '81d9084cfeab' });
  } finally {
    worker.close();
  }
});
test('Linux worker mounts only the selected project plus staged read grants', { skip: !linuxSandboxAvailable }, async () => {
  const { createTurnWorker } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-capability-mounts-'));
  const projectA = path.join(workspace, 'project-a'); const projectB = path.join(workspace, 'project-b');
  await (await import('node:fs/promises')).mkdir(projectA); await (await import('node:fs/promises')).mkdir(projectB);
  await writeFile(path.join(projectA, 'normal.md'), 'normal\n');
  const privateFile = path.join(projectB, 'private.md'); await writeFile(privateFile, 'private\n');
  const worker = await createTurnWorker(projectA, { readGrants: [{ id: 'grant-privatefile', canonicalPath: privateFile }] });
  try {
    assert.equal((await worker.call('read_file', { path: 'normal.md' })).content, 'normal\n');
    await assert.rejects(worker.call('read_file', { path: '../project-b/private.md', scope: 'workspace' }));
    assert.equal((await worker.call('read_granted_file', { grant_id: 'grant-privatefile' })).content, 'private\n');
    await assert.rejects(worker.call('read_granted_file', { grant_id: 'grant-invented' }));
  } finally { worker.close(); }
});
test('read grants are staged from one canonical no-follow file descriptor', async () => {
  const { stageReadGrants } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-grant-staging-'));
  const source = path.join(workspace, 'reference.md'); const alias = path.join(workspace, 'reference-alias.md');
  await writeFile(source, 'granted content\n'); await symlink(source, alias);
  await assert.rejects(stageReadGrants([{ id: 'grant-aliasedfile', canonicalPath: alias }]), /canonical path/);
  const staged = await stageReadGrants([{ id: 'grant-referencefile', canonicalPath: await realpath(source) }]);
  try { assert.equal(await readFile(staged.staged['grant-referencefile'], 'utf8'), 'granted content\n'); }
  finally { await rm(staged.directory, { recursive: true, force: true }); }
});
test('project tool result preserves the Pi tool-result envelope and creation metadata', async () => {
  const { projectToolResult } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const base = { content: [{ type: 'text', text: '{"id":"planning"}' }], details: { result: { id: 'planning', location: '/workspace/planning' } } };
  const result = projectToolResult(base, { initialized: true, repository: '/tmp/workspace' });
  assert.deepEqual(result.details.result, { id: 'planning', location: '/workspace/planning', git: { initialized: true, repository: '/tmp/workspace' } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details.result);
});
test('web search returns bounded, decoded, canonical public results', async () => {
  const { searchWeb } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1">Example &amp; docs</a><a class="result__snippet">A useful <b>search</b> result.</a></div>
    <div class="result"><a class="result__a" href="javascript:alert(1)">Unsafe</a></div>
    <div class="result"><a class="result__a" href="https://second.example/story">Second result</a><div class="result__snippet">More detail</div></div>`;
  let requested;
  const result = await searchWeb('release notes', { maxResults: 2, fetchImpl: async (url, options) => { requested = { url, options }; return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }); } });
  assert.match(requested.url, /q=release%20notes/);
  assert.equal(requested.options.headers.accept, 'text/html');
  assert.deepEqual(result, { query: 'release notes', results: [
    { title: 'Example & docs', url: 'https://example.com/docs?x=1', snippet: 'A useful search result.' },
    { title: 'Second result', url: 'https://second.example/story', snippet: 'More detail' },
  ] });
  await assert.rejects(searchWeb('', { fetchImpl: async () => { throw new Error('must not run'); } }), /1 to 500/);
  await assert.rejects(searchWeb('query', { maxResults: 9, fetchImpl: async () => { throw new Error('must not run'); } }), /1 to 8/);
});
test('workspace AGENTS.md is included as bounded system instructions', async () => {
  const { workspaceAgentInstructions } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-instructions-'));
  const project = path.join(workspace, 'project');
  await writeFile(path.join(workspace, 'AGENTS.md'), '# Workspace rules\n\nAlways preserve evidence.\n');
  await (await import('node:fs/promises')).mkdir(project);
  await writeFile(path.join(project, 'AGENTS.md'), '# Project rules\n\nKeep project notes current.\n');
  const instructions = await workspaceAgentInstructions(workspace, project);
  assert.match(instructions, /Project instructions are more specific and take precedence/);
  assert.match(instructions, /\[Workspace instructions: AGENTS\.md\][\s\S]*Always preserve evidence/);
  assert.match(instructions, /\[Project instructions: AGENTS\.md\][\s\S]*Keep project notes current/);
  assert.ok(instructions.indexOf('Always preserve evidence') < instructions.indexOf('Keep project notes current'));
});
test('agent instructions are fresh per turn, bounded, and not duplicated for the workspace project', async () => {
  const { workspaceAgentInstructions } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-instruction-freshness-'));
  const file = path.join(workspace, 'AGENTS.md');
  await writeFile(file, 'First workspace rule\n');
  const first = await workspaceAgentInstructions(workspace, workspace);
  assert.equal((first.match(/First workspace rule/g) || []).length, 1);
  await writeFile(file, 'Second workspace rule\n');
  assert.match(await workspaceAgentInstructions(workspace, workspace), /Second workspace rule/);
  await writeFile(file, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(workspaceAgentInstructions(workspace, workspace), /Workspace AGENTS\.md is too large/);
});
test('agent instruction loader ignores an AGENTS.md symbolic link', async () => {
  const { workspaceAgentInstructions } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-instruction-symlink-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ok-workbench-instruction-symlink-outside-'));
  await writeFile(path.join(outside, 'AGENTS.md'), 'Do not expose this content.\n');
  await symlink(path.join(outside, 'AGENTS.md'), path.join(workspace, 'AGENTS.md'));
  assert.equal(await workspaceAgentInstructions(workspace, workspace), '');
});
test('turn capabilities are project-scoped and accept only server-issued grants', async () => {
  const { createTurnCapabilities } = await import(path.join(root, 'dist', 'pi-harness.mjs'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-tool-context-'));
  const project = path.join(workspace, 'alpha');
  const other = path.join(workspace, 'beta');
  await (await import('node:fs/promises')).mkdir(project); await (await import('node:fs/promises')).mkdir(other);
  const granted = path.join(other, 'reference.md'); await writeFile(granted, 'explicit context\n');
  const capabilities = await createTurnCapabilities({ workspaceRoot: workspace, projectRoot: project, readGrants: [{ id: 'grant-abcdefgh', canonicalPath: granted }] });
  assert.equal(capabilities.selectedProject.root, await (await import('node:fs/promises')).realpath(project));
  assert.equal(capabilities.workspaceMode, false);
  assert.deepEqual(capabilities.extraReadGrants, [{ id: 'grant-abcdefgh', canonicalPath: await (await import('node:fs/promises')).realpath(granted) }]);
  await assert.rejects(createTurnCapabilities({ workspaceRoot: workspace, projectRoot: project, readGrants: [{ id: 'invented', canonicalPath: granted }] }), /Invalid read grant/);
  const outside = await mkdtemp(path.join(tmpdir(), 'ok-workbench-tool-context-outside-'));
  await assert.rejects(createTurnCapabilities({ workspaceRoot: workspace, projectRoot: outside }), /outside the workspace/);
  const source = await readFile(path.join(root, 'src', 'pi-harness.mjs'), 'utf8');
  assert.doesNotMatch(source, /Type\.Literal\('workspace'\)/);
  await assert.rejects(createTurnCapabilities({ workspaceRoot: workspace, projectRoot: workspace }), /explicit workspace mode/);
  const workspaceCapabilities = await createTurnCapabilities({ workspaceRoot: workspace, projectRoot: workspace, workspaceMode: true });
  assert.equal(workspaceCapabilities.workspaceMode, true);
  await assert.rejects(createTurnCapabilities({ workspaceRoot: workspace, projectRoot: project, workspaceMode: true }), /requires the workspace root/);
});
