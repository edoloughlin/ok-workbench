import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from 'playwright';

async function port() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }

test('navigation menu copies and deletes the selected page', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-nav-')); const state = await mkdtemp(path.join(tmpdir(), 'ok-nav-state-'));
  let server; let browser;
  try {
    await mkdir(path.join(workspace, 'alpha'));
    await writeFile(path.join(workspace, 'index.md'), '# Workspace\n\n- [Alpha](alpha/)\n');
    await writeFile(path.join(workspace, 'alpha', 'index.md'), '# Alpha\n\n- [Draft](draft.md)\n');
    await writeFile(path.join(workspace, 'alpha', 'draft.md'), '# Draft\n');
    await writeFile(path.join(workspace, 'alpha', 'other.md'), '# Other\n');
    await mkdir(path.join(workspace, 'alpha', 'folder'));
    await writeFile(path.join(workspace, 'alpha', 'folder', 'index.md'), '# Folder\n\n- [Child](child.md)\n');
    await writeFile(path.join(workspace, 'alpha', 'folder', 'child.md'), '# Child\n');
    const serverPort = await port(); let assetPort = await port(); while (assetPort === serverPort) assetPort = await port();
    server = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(serverPort), OK_WORKBENCH_ASSET_PORT: String(assetPort), OK_WORKBENCH_NATIVE_FILE_MANAGER: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 8000); server.stdout.once('data', () => { clearTimeout(timer); resolve(); }); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
    browser = await chromium.launch(); const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }); const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/alpha/other.md`, { waitUntil: 'domcontentloaded' });
    await page.locator('a[data-menu-path="/workspace/alpha/draft.md"]').waitFor();
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    const draft = page.locator('a[data-menu-path="/workspace/alpha/draft.md"]');
    await draft.focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: /Open containing folder/ }).getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('Escape'); assert.equal(await draft.evaluate(element => document.activeElement === element), true);
    await draft.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy absolute path' }).click();
    await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, path.join(workspace, 'alpha', 'draft.md'));
    await draft.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.locator('.tree-inline-rename input'); await rename.fill('Research'); await rename.press('Enter');
    await page.locator('a[data-menu-path="/workspace/alpha/research.md"]').waitFor();
    await page.locator('[data-markdown-edit]').click();
    await page.locator('#markdown-edit-source').fill('# Other\n\nUnsaved work\n');
    let deletes = 0; page.on('request', request => { if (request.method() === 'DELETE' && request.url().endsWith('/entries')) deletes++; });
    await page.locator('a[data-menu-path="/workspace/alpha/other.md"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    assert.match(await page.locator('.entry-delete-dialog').innerText(), /unsaved changes/i);
    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await page.locator('.entry-delete-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(deletes, 0); assert.match(await page.locator('#markdown-edit-source').inputValue(), /Unsaved work/);
    await page.locator('a[data-menu-path="/workspace/alpha/research.md"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    assert.match(await page.locator('.entry-delete-dialog').innerText(), /permanently deleted/i);
    await page.locator('.entry-delete-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.match(await readFile(path.join(workspace, 'alpha', 'research.md'), 'utf8'), /Research/);
    await page.locator('a[data-menu-path="/workspace/alpha/research.md"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await page.locator('a[data-menu-path="/workspace/alpha/research.md"]').waitFor({ state: 'detached' });
    await assert.rejects(readFile(path.join(workspace, 'alpha', 'research.md')));
    assert.match(await page.locator('#markdown-edit-source').inputValue(), /Unsaved work/);
    page.once('dialog', dialog => dialog.accept()); await page.locator('[data-markdown-cancel]').click();
    await page.goto(`http://127.0.0.1:${serverPort}/workspace/alpha/folder/child.md`, { waitUntil: 'domcontentloaded' });
    const folder = page.locator('a[data-menu-path="/workspace/alpha/folder"]'); await folder.waitFor();
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await folder.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const directoryRename = page.locator('.tree-inline-rename input'); await directoryRename.fill('New folder'); await directoryRename.press('Enter');
    await page.waitForURL('**/workspace/alpha/new-folder/child.md');
    assert.match(await readFile(path.join(workspace, 'alpha', 'new-folder', 'child.md'), 'utf8'), /Child/);
  } finally {
    await browser?.close(); if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
});
