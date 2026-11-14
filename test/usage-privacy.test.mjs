import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTurnWorker } from '../src/pi-harness.mjs';
import approvals from '../src/tool-approvals.js';
import usageStore from '../src/usage-store.js';

const sandboxAvailable = process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/usr/bin/true']).status === 0;

test('a custom in-workspace usage directory stays out of ordinary Git staging', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'usage-private-git-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', project]).status, 0);
    const store = new usageStore.UsageStore({ stateDir: project, workspaceRoot: project });
    await store.init();
    const op = await store.startOperation({ activity: 'chat', trigger: 'user' });
    await store.startRequest({ operationId: op.operationId, activity: 'chat' });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf8' });
    assert.equal(status.status, 0); assert.equal(status.stdout.trim(), '');
  } finally { await rm(project, { recursive: true, force: true }); }
});

for (const prefix of ['state/usage', 'usage']) {
  test(`usage under ${prefix} is hidden from file tools and approved workspace executables`, { skip: !sandboxAvailable }, async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'usage-private-project-'));
    const state = await mkdtemp(path.join(tmpdir(), 'usage-private-state-'));
    let worker;
    try {
      const usage = path.join(project, prefix);
      await mkdir(usage, { recursive: true });
      await writeFile(path.join(usage, 'private.jsonl'), 'PRIVATE_USAGE_MARKER');
      await mkdir(path.join(project, 'tools'));
      await writeFile(path.join(project, 'tools', 'probe.py'), `#!/usr/bin/env python3\nimport os\nprint(os.path.exists(${JSON.stringify(`/workspace/${prefix}/private.jsonl`)}))\n`);
      await chmod(path.join(project, 'tools', 'probe.py'), 0o755);
      const policy = await approvals.inspectTool(project, 'tools/probe.py');
      await approvals.approveTool(state, project, policy);
      const approval = await approvals.resolveToolApproval(state, project, policy);
      worker = await createTurnWorker(project, { privateRoots: [usage], executionPolicy: approval.executionPolicy });
      assert.ok(worker);
      await assert.rejects(worker.call('read_file', { path: `${prefix}/private.jsonl` }), /not available/);
      assert.ok(!(await worker.call('list_files', { path: '.' })).some(file => file.includes('private.jsonl')));
      const result = await worker.call('run_workspace_tool', { path: 'tools/probe.py', arguments: [] });
      assert.equal(result.stdout.trim(), 'False');
      assert.equal(await readFile(path.join(usage, 'private.jsonl'), 'utf8'), 'PRIVATE_USAGE_MARKER');
    } finally {
      worker?.close();
      await rm(project, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
}
