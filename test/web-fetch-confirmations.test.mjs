import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebFetchConfirmations } from '../src/web-fetch-confirmations.mjs';

function pending(registry, overrides = {}) {
  const events = [];
  const context = { browser: 'browser-a', threadId: 'thread-a', turnId: 'turn-a', toolCallId: 'tool-a', hop: 0, url: 'https://example.com/?secret=1', emit: (type, data) => events.push({ type, ...data }), ...overrides };
  const promise = registry.request(context);
  return { context, promise, events, id: events[0]?.request_id };
}

test('approval is context-bound, one-time, and does not accept a replacement URL', async () => {
  const registry = new WebFetchConfirmations();
  const p = pending(registry);
  assert.equal(p.events[0].url, p.context.url);
  const decision = { id: p.id, browser: p.context.browser, threadId: p.context.threadId, turnId: p.context.turnId, decision: 'allow' };
  assert.equal(registry.decide({ ...decision, browser: 'other' }), 404);
  assert.equal(registry.decide({ ...decision, turnId: 'other' }), 404);
  assert.equal(registry.decide({ ...decision, threadId: 'other' }), 404);
  assert.equal(registry.decide(decision), 204);
  await p.promise;
  assert.equal(registry.decide(decision), 409);
  assert.equal(p.events[1].outcome, 'allow');
  registry.cancelAll();
});

test('expiry and restart invalidate pending decisions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const registry = new WebFetchConfirmations();
  const p = pending(registry);
  const settled = assert.rejects(p.promise, { code: 'CONFIRMATION_EXPIRED' });
  t.mock.timers.tick(119_999);
  assert.equal(p.events.length, 1, 'confirmation remains pending before its deadline');
  t.mock.timers.tick(1);
  await settled;
  assert.equal(p.events[1].outcome, 'expired');
  const decision = { id: p.id, browser: p.context.browser, threadId: p.context.threadId, turnId: p.context.turnId, decision: 'allow' };
  assert.equal(registry.decide(decision), 409, 'expired decision retains a replay tombstone');
  const restarted = new WebFetchConfirmations();
  assert.equal(restarted.decide(decision), 404);
  t.mock.timers.tick(120_000);
  assert.equal(registry.decide(decision), 404, 'tombstone is eventually removed');
  registry.cancelAll(); restarted.cancelAll();
});

test('cancellation wins over a subsequent allow and resolves only once', async () => {
  const registry = new WebFetchConfirmations(); const controller = new AbortController();
  const p = pending(registry, { signal: controller.signal });
  controller.abort();
  assert.equal(registry.decide({ id: p.id, browser: p.context.browser, threadId: p.context.threadId, turnId: p.context.turnId, decision: 'allow' }), 409);
  await assert.rejects(p.promise, { code: 'CANCELLED' });
  assert.equal(p.events.filter(event => event.type === 'web_fetch.confirmation_resolved').length, 1);
  registry.cancelAll();
});

test('denial and cancellation fail closed', async () => {
  const registry = new WebFetchConfirmations();
  const p = pending(registry);
  assert.equal(registry.decide({ id: p.id, browser: p.context.browser, threadId: p.context.threadId, turnId: p.context.turnId, decision: 'deny' }), 204);
  await assert.rejects(p.promise, /USER_DENIED/);
  const controller = new AbortController();
  const q = pending(registry, { signal: controller.signal });
  controller.abort();
  await assert.rejects(q.promise, /CANCELLED/);
  assert.equal(registry.decide({ id: q.id, browser: q.context.browser, threadId: q.context.threadId, turnId: q.context.turnId, decision: 'allow' }), 409);
  registry.cancelAll();
});
