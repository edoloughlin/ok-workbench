import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configuredPiProviders, refreshPiCatalog } from '../src/pi-harness.mjs';

test('remote catalog refresh is shared with newly created provider runtimes', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'pi-catalog-'));
  const originalFetch = globalThis.fetch;
  const env = { OPENAI_API_KEY: 'test-key' };
  let requests = 0;
  try {
    const before = await configuredPiProviders({ stateDir, env });
    const baseline = before.find(provider => provider.id === 'openai').models[0];
    globalThis.fetch = async url => {
      if (!String(url).includes('/api/models/providers/openai')) return new Response('', { status: 404 });
      requests++;
      return new Response(JSON.stringify([{ id: 'catalog-test-model', name: 'Catalog test model', api: 'openai-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]), { status: 200, headers: { 'last-modified': 'Wed, 01 Jan 2099 00:00:00 GMT' } });
    };
    await Promise.all([refreshPiCatalog({ stateDir, env }), refreshPiCatalog({ stateDir, env })]);
    assert.equal(requests, 1);
    const after = await configuredPiProviders({ stateDir, env });
    const models = after.find(provider => provider.id === 'openai').models;
    assert.ok(models.some(model => model.id === 'catalog-test-model'));
    assert.ok(models.some(model => model.id === baseline.id));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(stateDir, { recursive: true, force: true });
  }
});
