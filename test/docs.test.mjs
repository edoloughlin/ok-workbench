import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const docs = path.resolve(import.meta.dirname, '..', 'docs');
const templates = path.join(docs, 'templates');
const seedTemplates = path.resolve(import.meta.dirname, '..', 'seed', 'workspace', 'templates');
async function markdownFiles(directory) { const result = []; for (const item of await readdir(directory, { withFileTypes: true })) { const target = path.join(directory, item.name); if (item.isDirectory()) result.push(...await markdownFiles(target)); else if (item.name.endsWith('.md')) result.push(target); } return result; }
async function files(directory) { const result = []; for (const item of await readdir(directory, { withFileTypes: true })) { const target = path.join(directory, item.name); if (item.isDirectory()) result.push(...await files(target)); else result.push(target); } return result; }
test('GitHub Pages documentation has complete relative links', async () => {
  for (const file of await markdownFiles(docs)) for (const match of (await readFile(file, 'utf8')).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1].split('#')[0]; if (!href || /^(?:https?:|mailto:)/.test(href)) continue;
    await stat(path.resolve(path.dirname(file), decodeURIComponent(href)));
  }
  assert.ok(true);
});
test('published templates are generated from the packaged seed', async () => {
  const expected = await files(seedTemplates);
  const actual = await files(templates);
  assert.deepEqual(actual.map(file => path.relative(templates, file)).sort(), expected.map(file => path.relative(seedTemplates, file)).sort());
  for (const source of expected) {
    const relative = path.relative(seedTemplates, source);
    assert.deepEqual(await readFile(path.join(templates, relative)), await readFile(source), relative);
  }
});
