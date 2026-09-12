import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const approvals = createRequire(import.meta.url)(path.join(root, 'dist', 'tool-approvals.js'));

async function fixture(manifest = { secrets: ['jira-token'], timeoutSeconds: 45 }) {
  const project = await mkdtemp(path.join(tmpdir(), 'ok-workbench-tool-approval-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-tool-state-'));
  await mkdir(path.join(project, 'tools'));
  const tool = path.join(project, 'tools', 'sync.js');
  await writeFile(tool, '#!/usr/bin/env node\nconsole.log(process.env.OK_WORKBENCH_TOOL_SECRET_JIRA_TOKEN || "missing");\n'); await chmod(tool, 0o755);
  await writeFile(path.join(project, 'tools', 'sync.tool.json'), JSON.stringify(manifest));
  return { project, state, tool };
}

test('workspace manifests only declare requirements and require an external hash-bound approval', async () => {
  const { project, state, tool } = await fixture();
  const policy = await approvals.inspectTool(project, 'tools/sync.js');
  assert.deepEqual(policy.requirements, { secrets: ['jira-token'], network: { hosts: [], ports: [] }, timeoutSeconds: 45 });
  assert.equal((await approvals.toolApprovalStatus(state, project, policy)).approved, false);
  await approvals.setToolSecret(state, 'jira-token', 'tool-only-secret');
  await assert.rejects(approvals.resolveToolApproval(state, project, policy), /explicit user approval/);
  await approvals.approveTool(state, project, policy);
  const resolved = await approvals.resolveToolApproval(state, project, policy);
  assert.deepEqual(resolved.environment, { OK_WORKBENCH_TOOL_SECRET_JIRA_TOKEN: 'tool-only-secret' });
  assert.equal(resolved.environment.OPENAI_API_KEY, undefined);
  assert.equal(resolved.executionPolicy.resourceLimits.memoryBytes, 512 * 1024 * 1024);
  await writeFile(tool, '#!/usr/bin/env node\nconsole.log("changed");\n');
  const changedTool = await approvals.inspectTool(project, 'tools/sync.js');
  assert.equal((await approvals.toolApprovalStatus(state, project, changedTool)).approved, false);
  await approvals.approveTool(state, project, changedTool);
  await writeFile(path.join(project, 'tools', 'sync.tool.json'), JSON.stringify({ secrets: ['jira-token'], timeoutSeconds: 46 }));
  const changedManifest = await approvals.inspectTool(project, 'tools/sync.js');
  assert.equal((await approvals.toolApprovalStatus(state, project, changedManifest)).approved, false);
});

test('a no-requirements executable still requires approval because it can modify its selected project', async () => {
  const { project, state } = await fixture({});
  const policy = await approvals.inspectTool(project, 'tools/sync.js');
  assert.equal((await approvals.toolApprovalStatus(state, project, policy)).required, true);
  await assert.rejects(approvals.resolveToolApproval(state, project, policy), /explicit user approval/);
});

test('tool manifests cannot request provider names, arbitrary environment variables, or private network targets', async () => {
  for (const manifest of [
    { secrets: ['openai-api-key'] },
    { environment: ['OPENAI_API_KEY'] },
    { network: true },
    { network: { hosts: ['127.0.0.1'] } },
    { network: { hosts: ['169.254.169.254'] } },
    { network: { hosts: ['localhost'] } },
  ]) {
    const { project } = await fixture(manifest);
    await assert.rejects(approvals.inspectTool(project, 'tools/sync.js'));
  }
});

test('approved network requirements remain fail-closed until a host-filtering broker exists', async () => {
  const { project, state } = await fixture({ network: { hosts: ['jira.example.com'], ports: [443] } });
  const policy = await approvals.inspectTool(project, 'tools/sync.js');
  await approvals.approveTool(state, project, policy);
  await assert.rejects(approvals.resolveToolApproval(state, project, policy), /network remains denied/);
});
