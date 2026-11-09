import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWebPage, createWebFetchBudget } from '../src/web-fetch.mjs';

// Real worker/resource integration checks, deliberately separate from fast tests.
test('deep HTML extraction leaves the supervisor event loop responsive', async () => {
  const html = `<main>${'<div>'.repeat(10000)}visible${'</div>'.repeat(10000)}</main>`;
  let heartbeats = 0; const timer = setInterval(() => { heartbeats++; }, 5);
  try {
    const result = await fetchWebPage({ url: 'https://example.com/' }, {
      budget: createWebFetchBudget(), confirmRequest: async () => {},
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async () => ({ status: 200, contentType: 'text/html', bytes: Buffer.from(html) }),
    });
    assert.equal(result.text, 'visible'); assert.ok(heartbeats > 0, 'worker extraction must not block the supervisor');
  } finally { clearInterval(timer); }
});

test('actual worker heap exhaustion fails safely and releases extraction capacity', { timeout: 6000 }, async () => {
  const html = Buffer.from('<p>x</p>'.repeat(245000));
  assert.ok(html.length < 2 * 1024 * 1024);
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => ({ status: 200, contentType: 'text/html', bytes: html }) });
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options()), { code: 'RESOURCE_LIMIT' });
  const result = await fetchWebPage({ url: 'https://example.com/' }, { ...options(), transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') }) });
  assert.equal(result.text, 'ok');
});
