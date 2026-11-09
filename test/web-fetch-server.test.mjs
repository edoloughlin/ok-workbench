import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function port() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }

test('server binds a live confirmation to the originating browser, thread and turn', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-fetch-server-')); const state = await mkdtemp(path.join(tmpdir(), 'ok-fetch-state-'));
  let server;
  try {
    await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
    const serverPort = await port(); let assetPort = await port(); while (assetPort === serverPort) assetPort = await port();
    server = spawn(process.execPath, ['--experimental-loader', path.resolve('test/fixtures/web-fetch/harness-loader.mjs'), 'dist/server.js'], { env: { ...process.env, PI_OFFLINE: '1', OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(serverPort), OK_WORKBENCH_ASSET_PORT: String(assetPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 10000); server.stdout.once('data', () => { clearTimeout(timer); resolve(); }); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
    const base = `http://127.0.0.1:${serverPort}`;
    const csrf = (await (await fetch(`${base}/api/chat/session`)).json()).csrf;
    const browser = 'b'.repeat(64); const headers = { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf, 'x-ok-workbench-browser': browser };
    const created = await fetch(`${base}/api/chat/threads`, { method: 'POST', headers, body: JSON.stringify({ project: 'workspace', workspaceMode: true, provider: 'openai', model: 'fixture' }) });
    assert.equal(created.status, 201); const thread = await created.json();
    const turn = await fetch(`${base}/api/chat/threads/${thread.id}/turns`, { method: 'POST', headers, body: JSON.stringify({ message: 'Read the source', provider: 'openai', model: 'fixture' }) });
    assert.equal(turn.status, 200); const reader = turn.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = [];
    async function nextEvent() {
      while (!buffer.includes('\n')) { const part = await reader.read(); assert.equal(part.done, false, 'stream closed unexpectedly'); buffer += decoder.decode(part.value, { stream: true }); }
      const index = buffer.indexOf('\n'); const event = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); events.push(event); return event;
    }
    let event; do { event = await nextEvent(); } while (event.type !== 'web_fetch.confirmation_required');
    assert.equal(event.tool_call_id, 'fixture-tool-call'); assert.equal(event.url, 'https://example.com/path?token=visible');
    const endpoint = `${base}/api/chat/threads/${thread.id}/turns/${event.turn_id}/web-fetch-confirmations/${event.request_id}`;
    const decide = (extraHeaders, data = { decision: 'allow' }, endpointUrl = endpoint) => fetch(endpointUrl, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(data) });
    assert.equal((await decide({ 'x-ok-workbench-browser': 'c'.repeat(64) })).status, 404);
    assert.equal((await decide({}, { decision: 'allow', url: 'https://example.com/' })).status, 400);
    assert.equal((await decide({})).status, 204);
    assert.equal((await decide({})).status, 409);
    do { event = await nextEvent(); } while (event.type !== 'turn.completed');
    assert.ok(events.some(item => item.type === 'web_fetch.confirmation_resolved' && item.outcome === 'allow'));
    assert.ok(events.some(item => item.type === 'tool.completed' && item.result?.text === 'fixture source'));
    const saved = await (await fetch(`${base}/api/chat/threads/${thread.id}`)).json();
    assert.ok(!JSON.stringify(saved).includes('confirmation_required'));

    async function pendingTurn() {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/chat/threads/${thread.id}/turns`, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ message: 'Read again', provider: 'openai', model: 'fixture' }) });
      assert.equal(response.status, 200);
      const stream = response.body.getReader(); let data = ''; const utf8 = new TextDecoder();
      while (true) {
        const part = await stream.read(); assert.equal(part.done, false);
        data += utf8.decode(part.value, { stream: true });
        const lines = data.split('\n'); data = lines.pop();
        for (const line of lines) {
          const item = JSON.parse(line);
          if (item.type === 'web_fetch.confirmation_required') return { controller, stream, item };
        }
      }
    }
    const denied = await pendingTurn();
    const deniedEndpoint = `${base}/api/chat/threads/${thread.id}/turns/${denied.item.turn_id}/web-fetch-confirmations/${denied.item.request_id}`;
    assert.equal((await decide({}, { decision: 'deny' }, deniedEndpoint)).status, 204);
    let deniedStream = '';
    while (true) { const part = await denied.stream.read(); if (part.done) break; deniedStream += decoder.decode(part.value, { stream: true }); }
    assert.match(deniedStream, /USER_DENIED/); assert.doesNotMatch(deniedStream, /fixture source/);

    const disconnected = await pendingTurn();
    const disconnectedEndpoint = `${base}/api/chat/threads/${thread.id}/turns/${disconnected.item.turn_id}/web-fetch-confirmations/${disconnected.item.request_id}`;
    disconnected.controller.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await decide({}, { decision: 'allow' }, disconnectedEndpoint)).status, 409, 'a disconnected stream must invalidate its pending approval');
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
});
