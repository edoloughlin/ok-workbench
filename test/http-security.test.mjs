import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const PREVIEW_BYTES = 2 * 1024 * 1024;
const INDEX_METADATA_BYTES = 256 * 1024;

async function availablePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function request({ port, hostname = '127.0.0.1', host, pathname, method = 'GET', body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, family: hostname.includes(':') ? 6 : 4, port, path: pathname, method, headers: { Host: host, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function startWorkbench({ workspace, state, port }) {
  const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], {
    env: { ...process.env, OK_WORKSPACE_ROOT: workspace, OK_WORKBENCH_STATE_DIR: state, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('workbench did not start')), 5_000);
    child.stdout.on('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`workbench exited with ${code}`)); });
  });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('HTTP routes require a strict loopback authority and workspace assets remain inert and bounded', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-http-security-'));
  const state = await mkdtemp(path.join(tmpdir(), 'ok-workbench-http-security-state-'));
  const port = await availablePort();
  let child;
  try {
    await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
    const maliciousSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/chat/session")</script></svg>';
    await writeFile(path.join(workspace, 'attack.svg'), maliciousSvg);
    await writeFile(path.join(workspace, 'renamed.png'), maliciousSvg);
    await writeFile(path.join(workspace, 'active.xml'), '<svg><script>fetch("/api/chat/session")</script></svg>');
    await writeFile(path.join(workspace, 'active.pdf'), '%PDF-1.7\n<script>fetch("/api/chat/session")</script>');
    await writeFile(path.join(workspace, 'large.md'), Buffer.alloc(PREVIEW_BYTES + 64, '#'));
    await writeFile(path.join(workspace, 'large.py'), Buffer.alloc(PREVIEW_BYTES + 64, 'x'));
    await writeFile(path.join(workspace, 'large.bin'), Buffer.alloc(PREVIEW_BYTES + 64, 0x61));
    await mkdir(path.join(workspace, 'metadata-project'));
    await writeFile(path.join(workspace, 'metadata-project', 'index.md'), Buffer.alloc(INDEX_METADATA_BYTES + 64, '#'));
    child = await startWorkbench({ workspace, state, port });

    const protectedRoutes = [
      ['/', 'GET'], ['/app.js', 'GET'], ['/api/project?path=/workspace/', 'GET'], ['/api/document?path=/workspace/index.md', 'GET'],
      ['/asset/workspace/attack.svg', 'GET'], ['/workspace/index.md', 'GET'], ['/api/chat/session', 'GET'], ['/api/projects', 'POST'],
    ];
    for (const host of ['attacker.invalid', `attacker.invalid:${port}`]) for (const [pathname, method] of protectedRoutes) {
      const response = await request({ port, host, pathname, method, body: method === 'POST' ? '{}' : undefined });
      assert.equal(response.status, 421, `${method} ${pathname} with ${host}`);
      assert.doesNotMatch(response.body.toString('utf8'), /csrf/i);
    }
    for (const host of ['localhost.evil', '127.0.0.1.evil', '[::1]evil', 'localhost:99999', 'localhost:abc']) {
      const response = await request({ port, host, pathname: '/api/project?path=/workspace/' });
      assert.equal(response.status, 421, host);
    }

    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, '[::1]', `[::1]:${port}`]) {
      const response = await request({ port, host, pathname: '/api/project?path=/workspace/' });
      assert.equal(response.status, 200, host);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
    }
    const ipv6 = await request({ port, hostname: '::1', host: `[::1]:${port}`, pathname: '/api/project?path=/workspace/' });
    assert.equal(ipv6.status, 200);

    const svgDocument = await request({ port, host: `localhost:${port}`, pathname: '/api/document?path=/workspace/attack.svg' });
    const svgData = JSON.parse(svgDocument.body);
    assert.equal(svgData.kind, 'code');
    assert.equal(svgData.fileType, 'SVG source');
    const svgAsset = await request({ port, host: `localhost:${port}`, pathname: '/asset/workspace/attack.svg' });
    assert.equal(svgAsset.status, 200);
    assert.equal(svgAsset.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(svgAsset.headers['content-disposition'], /^attachment;/);
    assert.match(svgAsset.headers['content-security-policy'], /script-src 'none'/);
    assert.match(svgAsset.headers['content-security-policy'], /sandbox/);
    assert.equal(svgAsset.headers['x-content-type-options'], 'nosniff');
    assert.equal(svgAsset.body.toString('utf8'), maliciousSvg);
    for (const filename of ['renamed.png', 'active.xml', 'active.pdf']) {
      const response = await request({ port, host: `localhost:${port}`, pathname: `/asset/workspace/${filename}` });
      assert.equal(response.status, 200);
      assert.match(response.headers['content-security-policy'], /default-src 'none'/);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      if (filename !== 'renamed.png') assert.match(response.headers['content-disposition'], /^attachment;/);
    }
    const pdfDocument = JSON.parse((await request({ port, host: `localhost:${port}`, pathname: '/api/document?path=/workspace/active.pdf' })).body);
    assert.equal(pdfDocument.kind, 'binary');

    const markdown = JSON.parse((await request({ port, host: `localhost:${port}`, pathname: '/api/document?path=/workspace/large.md' })).body);
    assert.equal(markdown.truncated, true);
    assert.ok(Buffer.byteLength(markdown.text) <= PREVIEW_BYTES);
    const code = JSON.parse((await request({ port, host: `localhost:${port}`, pathname: '/api/document?path=/workspace/large.py' })).body);
    assert.equal(code.kind, 'binary');
    assert.equal(code.truncated, true);
    const assetHead = await request({ port, host: `localhost:${port}`, method: 'HEAD', pathname: '/asset/workspace/large.bin' });
    assert.equal(assetHead.status, 200);
    assert.equal(Number(assetHead.headers['content-length']), PREVIEW_BYTES + 64);
    const assets = await Promise.all(Array.from({ length: 6 }, () => request({ port, host: `localhost:${port}`, pathname: '/asset/workspace/large.bin' })));
    assert.ok(assets.every(response => response.status === 200 && response.body.length === PREVIEW_BYTES + 64));
    const metadataProject = await request({ port, host: `localhost:${port}`, pathname: '/api/project?path=/workspace/metadata-project/' });
    assert.equal(metadataProject.status, 200);

    const source = await readFile(path.join(root, 'src', 'server.js'), 'utf8');
    assert.doesNotMatch(source, /async function asset\([\s\S]*?await fs\.readFile\(resolved\)/);
    assert.doesNotMatch(source, /fs\.readFile\(bundleIndexFile/);
    assert.match(source, /fsNative\.createReadStream\(resolved\)/);
  } finally {
    await stop(child);
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
