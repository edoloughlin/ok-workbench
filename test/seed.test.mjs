import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const seed = path.resolve(import.meta.dirname, '..', 'seed', 'workspace');
async function files(directory) { const result = []; for (const item of await readdir(directory, { withFileTypes: true })) { const target = path.join(directory, item.name); if (item.isDirectory()) result.push(...await files(target)); else result.push(target); } return result; }
test('seed manifest hashes managed files and all relative markdown links resolve', async () => {
  const manifest = JSON.parse(await readFile(path.join(seed, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.okf_version, '0.2'); assert.ok(manifest.workflow_version); assert.ok(manifest.seed_version);
  for (const [relative, expected] of Object.entries(manifest.managed_files)) {
    const content = await readFile(path.join(seed, relative)); const actual = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
    assert.equal(actual, expected, relative);
  }
  for (const required of ['AGENTS.md', 'index.md', 'status.md', 'log.md']) await stat(path.join(seed, 'example-project', required));
  for (const concept of ['brief.md', 'decision.md']) assert.match(await readFile(path.join(seed, 'example-project', concept), 'utf8'), /^---\ntype:/);
  for (const required of ['AGENTS.md', 'index.md', 'status.md', 'log.md']) await stat(path.join(seed, 'templates', 'project', required));
  for (const file of (await files(seed)).filter(file => file.endsWith('.md'))) {
    const markdown = await readFile(file, 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].split('#')[0]; if (!href || /^(?:https?:|mailto:)/.test(href)) continue;
      await stat(path.resolve(path.dirname(file), decodeURIComponent(href)));
    }
  }
});
