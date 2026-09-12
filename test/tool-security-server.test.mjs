import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
async function availablePort() { const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const { port } = probe.address(); await new Promise(resolve => probe.close(resolve)); return port; }
async function start(environment, port) {
  const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], { env: { ...process.env, ...environment, PORT: String(port), OK_WORKBENCH_ASSET_PORT: String(port + 1) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('workbench did not start')), 5_000); child.stdout.on('data', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); child.once('exit', code => reject(new Error(`workbench exited ${code}`))); });
  return child;
}

test('tool approval and secret APIs are CSRF-protected, external to the project, and hash-bound', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-tool-api-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-tool-api-state-'));
  const project = path.join(workspace, 'alpha'); await mkdir(path.join(project, 'tools'), { recursive: true }); await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
  const tool = path.join(project, 'tools', 'sync.js'); await writeFile(tool, '#!/usr/bin/env node\nconsole.log("sync");\n'); await chmod(tool, 0o755);
  await writeFile(path.join(project, 'tools', 'sync.tool.json'), JSON.stringify({ secrets: ['jira-token'] }));
  const port = await availablePort(); const child = await start({ OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, OPENAI_API_KEY: 'provider-must-not-be-tool-secret' }, port);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/workspace/`); const csrf = (await page.text()).match(/name="ok-workbench-csrf" content="([^"]+)"/)?.[1]; assert.ok(csrf);
    const endpoint = `http://127.0.0.1:${port}/api/projects/alpha/tools`;
    const noTokenApproval = await fetch(`http://127.0.0.1:${port}/api/projects/alpha/tools/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'tools/sync.js' }) }); assert.equal(noTokenApproval.status, 400);
    const headers = { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf };
    let response = await fetch(endpoint, { headers }); assert.equal(response.status, 200); let data = await response.json(); assert.equal(data.tools[0].approval.approved, false);
    response = await fetch(`http://127.0.0.1:${port}/api/chat/tool-secrets/openai-api-key`, { method: 'PUT', headers, body: JSON.stringify({ value: 'nope' }) }); assert.equal(response.status, 400);
    response = await fetch(`http://127.0.0.1:${port}/api/chat/tool-secrets/jira-token`, { method: 'PUT', headers, body: JSON.stringify({ value: 'tool-secret' }) }); assert.equal(response.status, 204);
    response = await fetch(`http://127.0.0.1:${port}/api/projects/alpha/tools/approvals`, { method: 'POST', headers, body: JSON.stringify({ path: 'tools/sync.js' }) }); assert.equal(response.status, 201);
    assert.match(await readFile(path.join(state, 'tool-approvals.json'), 'utf8'), /jira-token/);
    await assert.rejects(readFile(path.join(project, 'tool-approvals.json'), 'utf8'));
    await writeFile(tool, '#!/usr/bin/env node\nconsole.log("changed");\n');
    response = await fetch(endpoint, { headers }); data = await response.json(); assert.equal(data.tools[0].approval.approved, false);
  } finally { child.kill(); }
});
