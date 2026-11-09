import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from 'playwright';

async function port() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }

test('browser decision controls resolve a live server confirmation', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-fetch-live-')); const state = await mkdtemp(path.join(tmpdir(), 'ok-fetch-live-state-'));
  let server; let browser;
  try {
    await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
    const serverPort = await port(); let assetPort = await port(); while (assetPort === serverPort) assetPort = await port();
    server = spawn(process.execPath, ['--experimental-loader', path.resolve('test/fixtures/web-fetch/harness-loader.mjs'), 'dist/server.js'], { env: { ...process.env, PI_OFFLINE: '1', OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(serverPort), OK_WORKBENCH_ASSET_PORT: String(assetPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 10000); server.stdout.once('data', () => { clearTimeout(timer); resolve(); }); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
    browser = await chromium.launch(); const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.showWebFetchPrompt === 'function');
    await page.evaluate(async () => {
      const csrf = document.querySelector('meta[name="ok-workbench-csrf"]').content;
      const headers = { 'content-type': 'application/json', 'x-ok-workbench-csrf': csrf };
      const thread = await (await fetch('/api/chat/threads', { method: 'POST', headers, body: JSON.stringify({ project: 'workspace', workspaceMode: true, provider: 'openai', model: 'fixture' }) })).json();
      chatProjectId = 'workspace'; workspaceMode = true; chatThreadId = thread.id;
      chatUi.provider.replaceChildren(new Option('OpenAI', 'openai')); chatUi.model.replaceChildren(new Option('Fixture', 'fixture'));
      window.liveFetchDone = streamChatTurn('Read the source', { model: 'fixture' });
    });
    const panel = page.getByRole('region', { name: 'Web fetch confirmation' }); await panel.waitFor();
    assert.equal(await panel.getByLabel('Exact URL to fetch').inputValue(), 'https://example.com/path?token=visible');
    await panel.getByRole('button', { name: 'Allow this fetch' }).click(); await panel.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.liveFetchDone), true);
    assert.match(await page.locator('#chat-messages').innerText(), /fixture source/);
  } finally {
    await browser?.close(); if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
});
