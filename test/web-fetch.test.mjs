import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWebPage, createWebFetchBudget, WebFetchError } from '../src/web-fetch.mjs';
import { resolvePublicAddresses } from '../src/web-fetch-network.mjs';
import { createHook } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';
import { manualClock, settle } from './fixtures/web-fetch/manual-clock.mjs';

test('requires confirmation before DNS and separately for redirect', async () => {
  const calls = [];
  const options = {
    budget: createWebFetchBudget(),
    clock: () => Date.parse('2026-11-09T12:00:00.000Z'),
    confirmRequest: async ({ url, hop }) => calls.push(`confirm ${hop} ${url}`),
    resolver: async url => { calls.push(`dns ${url.href}`); return [{ address: '8.8.8.8', family: 4 }]; },
    transport: async url => {
      calls.push(`get ${url.href}`);
      return url.pathname === '/' ? { status: 302, locations: ['/next'] } : { status: 200, contentType: 'text/plain; charset=utf-8', bytes: Buffer.from('Hello') };
    },
  };
  const result = await fetchWebPage({ url: 'https://example.com/' }, options);
  assert.equal(result.text, 'Hello'); assert.equal(result.final_url, 'https://example.com/next');
  assert.equal(result.fetched_at, '2026-11-09T12:00:00.000Z');
  assert.deepEqual(Object.keys(result).sort(), ['content_type', 'fetched_at', 'final_url', 'status', 'text', 'title', 'truncated', 'untrusted', 'url']);
  assert.deepEqual(calls, ['confirm 0 https://example.com/', 'dns https://example.com/', 'get https://example.com/', 'confirm 1 https://example.com/next', 'dns https://example.com/next', 'get https://example.com/next']);
});

test('repeated fetches of the same URL require independent decisions', async () => {
  const decisions = [];
  const options = { budget: createWebFetchBudget(), confirmRequest: async ({ url }) => decisions.push(url), resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') }) };
  await fetchWebPage({ url: 'https://example.com/' }, options);
  await fetchWebPage({ url: 'https://example.com/' }, options);
  assert.deepEqual(decisions, ['https://example.com/', 'https://example.com/']);
});

test('redirect chains require a decision per hop and reject loops, downgrades and blocked destinations', async () => {
  const cases = [
    { start: 'https://example.com/', next: '/', code: 'REDIRECT_ERROR' },
    { start: 'https://example.com/', next: 'http://example.com/', code: 'REDIRECT_ERROR' },
    { start: 'https://example.com/', next: 'http://127.0.0.1/', code: 'BLOCKED_DESTINATION' },
  ];
  for (const item of cases) {
    const calls = [];
    await assert.rejects(fetchWebPage({ url: item.start }, {
      budget: createWebFetchBudget(), confirmRequest: async ({ url }) => calls.push(`confirm ${url}`),
      resolver: async url => { calls.push(`dns ${url.href}`); return [{ address: '8.8.8.8', family: 4 }]; },
      transport: async () => ({ status: 302, locations: [item.next] }),
    }), { code: item.code });
    assert.deepEqual(calls, [`confirm ${item.start}`, `dns ${item.start}`]);
  }
  const confirmations = [];
  await assert.rejects(fetchWebPage({ url: 'https://example.com/0' }, {
    budget: createWebFetchBudget(), confirmRequest: async ({ hop }) => confirmations.push(hop),
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async url => ({ status: 302, locations: [`/${Number(url.pathname.slice(1)) + 1}`] }),
  }), { code: 'REDIRECT_ERROR' });
  assert.deepEqual(confirmations, [0, 1, 2, 3, 4, 5]);
});

test('all supported redirect status codes initiate a new approved GET', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const approvals = [];
    const result = await fetchWebPage({ url: 'https://example.com/start' }, {
      budget: createWebFetchBudget(), confirmRequest: async ({ url }) => approvals.push(url),
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async url => url.pathname === '/start' ? { status, locations: ['/final'] } : { status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') },
    });
    assert.equal(result.final_url, 'https://example.com/final');
    assert.deepEqual(approvals, ['https://example.com/start', 'https://example.com/final']);
  }
});

test('five redirects are allowed and each hop is approved and resolved', async () => {
  const confirmations = []; const lookups = [];
  const result = await fetchWebPage({ url: 'https://example.com/0' }, {
    budget: createWebFetchBudget(), confirmRequest: async ({ hop }) => confirmations.push(hop),
    resolver: async url => { lookups.push(url.pathname); return [{ address: '8.8.8.8', family: 4 }]; },
    transport: async url => Number(url.pathname.slice(1)) < 5 ? { status: 302, locations: [`/${Number(url.pathname.slice(1)) + 1}`] } : { status: 200, contentType: 'text/plain', bytes: Buffer.from('complete') },
  });
  assert.equal(result.final_url, 'https://example.com/5'); assert.equal(result.text, 'complete');
  assert.deepEqual(confirmations, [0, 1, 2, 3, 4, 5]); assert.deepEqual(lookups, ['/0', '/1', '/2', '/3', '/4', '/5']);
});

test('redirect validation rejects missing, duplicate and long locations before another request', async () => {
  for (const locations of [[], [''], ['/a', '/b'], ['/' + 'a'.repeat(4096)]]) {
    let confirmations = 0; let requests = 0;
    await assert.rejects(fetchWebPage({ url: 'http://example.com/' }, {
      budget: createWebFetchBudget(), confirmRequest: async () => { confirmations++; },
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async () => { requests++; return { status: 302, locations }; },
    }), { code: 'REDIRECT_ERROR' });
    assert.equal(confirmations, 1); assert.equal(requests, 1);
  }
});

test('cross-origin and HTTP-to-HTTPS redirects require new exact-URL approval', async () => {
  const confirmations = []; const dns = [];
  const result = await fetchWebPage({ url: 'http://example.com/a#fragment' }, {
    budget: createWebFetchBudget(), confirmRequest: async ({ url, previousOrigin, hop }) => confirmations.push({ url, previousOrigin, hop }),
    resolver: async url => { dns.push(url.href); return [{ address: '8.8.8.8', family: 4 }]; },
    transport: async url => url.protocol === 'http:' ? { status: 301, locations: ['https://other.example.net/final?q=2#x'] } : { status: 200, contentType: 'text/plain', bytes: Buffer.from('source') },
  });
  assert.equal(result.url, 'http://example.com/a'); assert.equal(result.final_url, 'https://other.example.net/final?q=2');
  assert.deepEqual(confirmations, [{ url: 'http://example.com/a', previousOrigin: null, hop: 0 }, { url: 'https://other.example.net/final?q=2', previousOrigin: 'http://example.com', hop: 1 }]);
  assert.deepEqual(dns, confirmations.map(item => item.url));
});

test('rejects invalid output limits before confirmation or DNS', async () => {
  let called = false;
  for (const max_chars of [null, undefined, '1000', 999, 40001, 1000.5]) {
    await assert.rejects(fetchWebPage({ url: 'https://example.com/', max_chars }, {
      budget: createWebFetchBudget(),
      confirmRequest: async () => { called = true; },
      resolver: async () => { called = true; },
    }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(called, false);
});

test('missing or denied confirmation cannot reach DNS', async () => {
  let dns = false;
  const resolver = async () => { dns = true; return []; };
  const unavailableBudget = createWebFetchBudget();
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, { budget: unavailableBudget, resolver }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(unavailableBudget.attempts, 1);
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, { confirmRequest: async () => {}, resolver }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, { budget: createWebFetchBudget(), resolver, confirmRequest: async () => { throw new WebFetchError('USER_DENIED', 'Fetch denied'); } }), { code: 'USER_DENIED' });
  assert.equal(dns, false);
});

test('turn request budget is checked before prompting and reserved atomically before DNS', async () => {
  const budget = createWebFetchBudget(); budget.requests = 11;
  let release; let lookups = 0; let confirmations = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const options = {
    budget,
    confirmRequest: async () => { confirmations++; },
    resolver: async () => { lookups++; await gate; return [{ address: '8.8.8.8', family: 4 }]; },
    transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') }),
  };
  const first = fetchWebPage({ url: 'https://example.com/' }, options);
  const second = fetchWebPage({ url: 'https://example.com/' }, options);
  await assert.rejects(second, { code: 'RESOURCE_LIMIT' });
  assert.equal(lookups, 1); assert.equal(budget.requests, 12);
  release(); await first;
  const count = confirmations;
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options), { code: 'RESOURCE_LIMIT' });
  assert.equal(confirmations, count);
});

test('parallel turns share four active slots and cancelled queue waiters leave the queue', async () => {
  let started = 0; const releases = [];
  const resolver = () => new Promise(resolve => { started++; releases.push(() => resolve([{ address: '8.8.8.8', family: 4 }])); });
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver, transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') }) });
  const first = Array.from({ length: 4 }, () => fetchWebPage({ url: 'https://example.com/' }, options()));
  const controller = new AbortController(); const successorController = new AbortController(); let successor;
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(started, 4);
    const waiting = fetchWebPage({ url: 'https://example.com/' }, { ...options(), signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(started, 4);
    controller.abort(); await assert.rejects(waiting, { code: 'CANCELLED' });
    successor = fetchWebPage({ url: 'https://example.com/' }, { ...options(), signal: successorController.signal });
    releases[0]();
    await first[0];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 5, 'a queued invocation takes the released slot');
    releases.forEach(release => release());
    await Promise.all([...first, successor]);
  } finally {
    controller.abort(); successorController.abort(); releases.forEach(release => release());
    await Promise.allSettled([...first, ...(successor ? [successor] : [])]);
  }
});

test('work-slot wait expires and removes the queued invocation', async t => {
  const clock = manualClock(t);
  const releases = [];
  const resolver = () => new Promise(resolve => releases.push(() => resolve([{ address: '8.8.8.8', family: 4 }])));
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver, transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') }) });
  const running = Array.from({ length: 4 }, () => fetchWebPage({ url: 'https://example.com/' }, options()));
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(releases.length, 4);
    let finished = false;
    const waiting = fetchWebPage({ url: 'https://example.com/' }, options());
    const rejected = assert.rejects(waiting, { code: 'RESOURCE_LIMIT' }).then(() => { finished = true; });
    await settle();
    clock.advance(9_999); await settle();
    assert.equal(finished, false, 'queue reservation must last until its deadline');
    clock.advance(1); await rejected;
    assert.equal(releases.length, 4, 'expired waiter must not start DNS');
  } finally { clock.restore(); releases.forEach(release => release()); await Promise.all(running); }
  const result = await fetchWebPage({ url: 'https://example.com/' }, { ...options(), resolver: async () => [{ address: '8.8.8.8', family: 4 }] });
  assert.equal(result.text, 'ok');
});

test('absolute deadline expires while awaiting confirmation', async t => {
  const clock = manualClock(t); let dns = false; let finished = false;
  const rejected = assert.rejects(fetchWebPage({ url: 'https://example.com/' }, {
    budget: createWebFetchBudget(),
    confirmRequest: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new WebFetchError('CANCELLED', 'Fetch cancelled')), { once: true })),
    resolver: async () => { dns = true; return []; },
  }), { code: 'TIMEOUT' }).then(() => { finished = true; });
  clock.advance(179_999); await settle();
  assert.equal(finished, false);
  clock.advance(1); await rejected;
  assert.equal(dns, false);
});

test('absolute deadline while waiting for a work slot reports timeout', async t => {
  let clock;
  const releases = [];
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: () => new Promise(resolve => releases.push(() => resolve([{ address: '8.8.8.8', family: 4 }]))), transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') }) });
  const running = Array.from({ length: 4 }, () => fetchWebPage({ url: 'https://example.com/' }, options()));
  try {
    await settle(); assert.equal(releases.length, 4);
    clock = manualClock(t);
    const approval = Promise.withResolvers();
    const rejected = assert.rejects(fetchWebPage({ url: 'https://example.com/' }, {
      ...options(), confirmRequest: () => approval.promise,
    }), { code: 'TIMEOUT' });
    // Approval consumes almost the entire absolute budget, but not active work.
    clock.advance(179_999);
    approval.resolve(); await settle();
    assert.equal(releases.length, 4);
    clock.advance(1); await rejected;
    assert.equal(releases.length, 4);
  } finally { clock?.restore(); releases.forEach(release => release()); await Promise.all(running); }
});

test('active-work deadline is cumulative across redirects', async t => {
  const clock = manualClock(t); let connected = 0; let confirmations = 0;
  let release;
  try {
    const rejected = assert.rejects(fetchWebPage({ url: 'https://example.com/first' }, {
      budget: createWebFetchBudget(), confirmRequest: async () => { confirmations++; },
      resolver: (url, { signal }) => url.pathname === '/first' ? Promise.resolve([{ address: '8.8.8.8', family: 4 }]) : resolvePublicAddresses(url, { signal, interfaces: () => ({}), resolver: () => new Promise(resolve => { release = resolve; }) }),
      transport: async () => { connected++; clock.advance(14_000); return { status: 302, locations: ['/second'] }; },
    }), { code: 'TIMEOUT' });
    await settle();
    assert.equal(typeof release, 'function');
    clock.advance(999); await settle();
    assert.equal(connected, 1);
    clock.advance(1); await rejected;
    assert.equal(confirmations, 2); assert.equal(connected, 1);
  } finally { release?.([{ address: '8.8.8.8', family: 4 }]); }
});

test('active work deadline stops a stalled DNS lookup without connecting', async t => {
  const clock = manualClock(t);
  let releaseLookup; let connected = false; let finished = false;
  const resolver = (url, { signal }) => resolvePublicAddresses(url, {
    signal, interfaces: () => ({}), resolver: () => new Promise(resolve => { releaseLookup = resolve; }),
  });
  try {
    const rejected = assert.rejects(fetchWebPage({ url: 'https://example.com/' }, {
      budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver,
      transport: async () => { connected = true; },
    }), { code: 'TIMEOUT' }).then(() => { finished = true; });
    await settle();
    assert.equal(typeof releaseLookup, 'function', 'DNS must be in flight before advancing time');
    clock.advance(14_999); await settle();
    assert.equal(finished, false);
    clock.advance(1); await rejected;
    assert.equal(connected, false);
  } finally { releaseLookup?.([{ address: '8.8.8.8', family: 4 }]); }
  await settle();
  assert.equal(connected, false, 'late DNS completion must not start transport');
});

test('already cancelled calls never prompt, resolve or connect', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, {
    budget: createWebFetchBudget(), signal: controller.signal,
    confirmRequest: async () => { calls++; }, resolver: async () => { calls++; }, transport: async () => { calls++; },
  }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
});

test('a late DNS answer after cancellation never starts transport', async () => {
  const controller = new AbortController(); let release; let connections = 0;
  const pending = fetchWebPage({ url: 'https://example.com/' }, {
    budget: createWebFetchBudget(), signal: controller.signal, confirmRequest: async () => {},
    resolver: (url, { signal }) => resolvePublicAddresses(url, { signal, interfaces: () => ({}), resolver: () => new Promise(resolve => { release = resolve; }) }),
    transport: async () => { connections++; },
  });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  release([{ address: '8.8.8.8', family: 4 }]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections, 0);
});

test('caller cancellation wins when an absolute timeout also occurs', async t => {
  const clock = manualClock(t); const controller = new AbortController();
  const rejected = assert.rejects(fetchWebPage({ url: 'https://example.com/' }, {
    budget: createWebFetchBudget(), signal: controller.signal,
    confirmRequest: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new WebFetchError('CANCELLED', 'Fetch cancelled')), { once: true })),
  }), { code: 'CANCELLED' });
  // Both signals abort before the rejection continuation runs.
  controller.abort(); clock.advance(180_000);
  await rejected;
});

test('cancellation between resolution and connection never calls the transport', async () => {
  const controller = new AbortController(); let connections = 0;
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, {
    budget: createWebFetchBudget(), signal: controller.signal, confirmRequest: async () => {},
    resolver: async () => { controller.abort(); return [{ address: '8.8.8.8', family: 4 }]; },
    transport: async () => { connections++; },
  }), { code: 'CANCELLED' });
  assert.equal(connections, 0);
});

test('pending confirmations share a bounded process-wide admission limit', async () => {
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  let prompts = 0; let lookups = 0;
  const options = controller => ({
    budget: createWebFetchBudget(), signal: controller.signal,
    confirmRequest: ({ signal }) => new Promise((_resolve, reject) => {
      prompts++; signal.addEventListener('abort', () => reject(new WebFetchError('CANCELLED', 'Fetch cancelled')), { once: true });
    }),
    resolver: async () => { lookups++; return []; },
  });
  const calls = controllers.map(controller => fetchWebPage({ url: 'https://example.com/' }, options(controller)));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(prompts, 16);
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options(new AbortController())), { code: 'RESOURCE_LIMIT' });
  assert.equal(prompts, 16); assert.equal(lookups, 0);
  controllers.forEach(controller => controller.abort());
  await Promise.all(calls.map(promise => assert.rejects(promise, { code: 'CANCELLED' })));
  const controller = new AbortController(); const recovered = fetchWebPage({ url: 'https://example.com/' }, options(controller));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(prompts, 17);
  controller.abort(); await assert.rejects(recovered, { code: 'CANCELLED' });
});

test('work-slot waits and pending confirmations share the same admission cap', async () => {
  const releases = []; const controllers = []; const pending = [];
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: () => new Promise(resolve => releases.push(() => resolve([{ address: '8.8.8.8', family: 4 }]))), transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('ok') }) });
  const active = Array.from({ length: 4 }, () => fetchWebPage({ url: 'https://example.com/' }, options()));
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(releases.length, 4);
    const queuedController = new AbortController(); controllers.push(queuedController);
    const queued = fetchWebPage({ url: 'https://example.com/' }, { ...options(), signal: queuedController.signal }); pending.push(queued);
    await new Promise(resolve => setImmediate(resolve));
    let prompts = 0;
    for (let i = 0; i < 15; i++) {
      const controller = new AbortController(); controllers.push(controller);
      pending.push(fetchWebPage({ url: 'https://example.com/' }, { budget: createWebFetchBudget(), signal: controller.signal, confirmRequest: ({ signal }) => new Promise((_resolve, reject) => { prompts++; signal.addEventListener('abort', () => reject(new WebFetchError('CANCELLED', 'Fetch cancelled')), { once: true }); }) }));
    }
    await new Promise(resolve => setImmediate(resolve)); assert.equal(prompts, 15);
    await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, { budget: createWebFetchBudget(), confirmRequest: async () => { prompts++; } }), { code: 'RESOURCE_LIMIT' });
    assert.equal(prompts, 15);
  } finally {
    controllers.forEach(controller => controller.abort()); releases.forEach(release => release());
    await Promise.allSettled([...active, ...pending]);
  }
});

test('parallel extraction starts no more than two workers at once', async () => {
  let active = 0; let peak = 0;
  // Async resource destroy hooks can run after termination resolves, so count
  // workers until terminate() settles rather than until the destroy callback.
  const hook = createHook({ init(_id, type) { if (type === 'WORKER') { active++; peak = Math.max(peak, active); } } });
  const terminate = Worker.prototype.terminate;
  Worker.prototype.terminate = function (...args) {
    return terminate.apply(this, args).finally(() => { active--; });
  };
  const html = `<main>${'<div>'.repeat(20000)}visible${'</div>'.repeat(20000)}</main>`;
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => ({ status: 200, contentType: 'text/html', bytes: Buffer.from(html) }) });
  hook.enable();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => fetchWebPage({ url: 'https://example.com/' }, options())));
    assert.ok(results.every(result => result.text === 'visible')); assert.equal(peak, 2); assert.equal(active, 0);
  } finally { hook.disable(); Worker.prototype.terminate = terminate; }
});

test('extraction deadline terminates the worker and releases its slot', async t => {
  const clock = manualClock(t); const listening = Promise.withResolvers();
  const once = Worker.prototype.once; const terminate = Worker.prototype.terminate; let terminated = false;
  Worker.prototype.once = function (event, listener) {
    if (event === 'message') { listening.resolve(); return once.call(this, event, () => {}); }
    return once.call(this, event, listener);
  };
  Worker.prototype.terminate = function (...args) { return terminate.apply(this, args).then(value => { terminated = true; return value; }); };
  const options = { budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('source') }) };
  try {
    const rejected = assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options), { code: 'TIMEOUT' });
    await listening.promise;
    clock.advance(1_999); await settle();
    assert.equal(terminated, false);
    clock.advance(1); await rejected;
    assert.equal(terminated, true);
  } finally { clock.restore(); Worker.prototype.once = once; Worker.prototype.terminate = terminate; }
  assert.equal((await fetchWebPage({ url: 'https://example.com/' }, { ...options, budget: createWebFetchBudget() })).text, 'source');
});

test('malformed worker messages and memory failures are mapped safely and cleaned up', async () => {
  const original = Worker.prototype.once; const terminate = Worker.prototype.terminate; let terminations = 0; let mode = 'malformed';
  Worker.prototype.once = function (event, listener) {
    if (event === 'message') return original.call(this, event, () => {
      if (mode === 'malformed') listener({ text: 'bad', title: null, truncated: false, extra: 'unexpected' });
      else this.emit('error', Object.assign(new Error('private internal detail'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
    });
    return original.call(this, event, listener);
  };
  Worker.prototype.terminate = function (...args) { return terminate.apply(this, args).then(value => { terminations++; return value; }); };
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('source') }) });
  try {
    await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options()), { code: 'EXTRACTION_ERROR' });
    mode = 'memory';
    await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options()), error => error.code === 'RESOURCE_LIMIT' && !error.message.includes('private internal detail'));
    assert.equal(terminations, 2);
  } finally { Worker.prototype.once = original; Worker.prototype.terminate = terminate; }
});

test('cancellation after extraction prevents returning success', async () => {
  const controller = new AbortController(); const original = Worker.prototype.terminate;
  Worker.prototype.terminate = function (...args) { return original.apply(this, args).then(value => { controller.abort(); return value; }); };
  try {
    await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, {
      budget: createWebFetchBudget(), signal: controller.signal, confirmRequest: async () => {},
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('source') }),
    }), { code: 'CANCELLED' });
  } finally { Worker.prototype.terminate = original; }
});

test('cancelling extraction terminates work and permits subsequent extraction', async t => {
  const controller = new AbortController(); const once = Worker.prototype.once;
  let extractionStarted = false;
  const listenerMock = t.mock.method(Worker.prototype, 'once', function (event, listener) {
    if (event === 'message') {
      extractionStarted = true;
      queueMicrotask(() => controller.abort());
    }
    return once.call(this, event, listener);
  });
  const options = {
    budget: createWebFetchBudget(), signal: controller.signal, confirmRequest: async () => {},
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('source') }),
  };
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options), { code: 'CANCELLED' });
  assert.equal(extractionStarted, true, 'cancel only after worker listeners are installed');
  listenerMock.mock.restore();
  const result = await fetchWebPage({ url: 'https://example.com/' }, {
    ...options, budget: createWebFetchBudget(), signal: undefined,
    transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('next') }),
  });
  assert.equal(result.text, 'next');
});

test('turn attempt and cumulative byte budgets reject excess without refunding bytes', async () => {
  const attempts = createWebFetchBudget(); let prompts = 0;
  const deny = { budget: attempts, confirmRequest: async () => { prompts++; throw new WebFetchError('USER_DENIED', 'Fetch denied'); } };
  for (let i = 0; i < 8; i++) await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, deny), { code: 'USER_DENIED' });
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, deny), { code: 'RESOURCE_LIMIT' });
  assert.equal(prompts, 8);
  const budget = createWebFetchBudget(); budget.bytes = 8 * 1024 * 1024 - 1;
  const options = { budget, confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async (_url, _records, { onBytes }) => { onBytes(2); throw new Error('unreachable'); } };
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, options), { code: 'RESOURCE_LIMIT' });
  assert.equal(budget.bytes, 8 * 1024 * 1024 + 1);
});

test('declared character sets are validated rather than silently ignored', async () => {
  const run = contentType => fetchWebPage({ url: 'https://example.com/' }, {
    budget: createWebFetchBudget(), confirmRequest: async () => {},
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async () => ({ status: 200, contentType, bytes: Buffer.from('hello') }),
  });
  assert.equal((await run('text/plain; charset="UTF-8"')).text, 'hello');
  for (const type of ['text/plain; charset=', 'text/plain; charset="utf-8', 'text/plain; charset="bad value"', 'text/plain; charset=shift_jis', 'text/plain; charset=utf-8; charset=utf-8']) {
    await assert.rejects(run(type), { code: 'UNSUPPORTED_ENCODING' }, type);
  }
});

test('output truncation respects both bounds and never splits a surrogate pair', async () => {
  const text = `${'a'.repeat(999)}😀${'b'.repeat(38999)}`;
  const options = () => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from(text) }) });
  const short = await fetchWebPage({ url: 'https://example.com/', max_chars: 1000 }, options());
  assert.equal(short.text, 'a'.repeat(999)); assert.equal(short.truncated, true);
  const defaultLimit = await fetchWebPage({ url: 'https://example.com/' }, options());
  assert.equal(defaultLimit.text.length, 20000); assert.equal(defaultLimit.truncated, true);
  const full = await fetchWebPage({ url: 'https://example.com/', max_chars: 40000 }, options());
  assert.equal(full.text, text); assert.equal(full.truncated, false);
});

test('contract validates arguments and supports text, Markdown and JSON encodings', async () => {
  const make = (type, bytes) => ({ budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => ({ status: 200, contentType: type, bytes }) });
  for (const params of [null, [], {}, { url: 'https://example.com/', extra: true }, { url: 'x'.repeat(4097) }, { url: 'https://example.com/', max_chars: 999 }, { url: 'https://example.com/', max_chars: 40001 }]) {
    await assert.rejects(fetchWebPage(params, make('text/plain', Buffer.from('ok'))), { code: 'INVALID_ARGUMENT' });
  }
  for (const mime of ['text/plain', 'text/markdown', 'application/json', 'application/problem+json']) {
    const result = await fetchWebPage({ url: 'https://example.com/', max_chars: 1000 }, make(mime, Buffer.from(' \r\nhello\0 ')));
    assert.equal(result.text, 'hello'); assert.equal(result.content_type, mime); assert.equal(result.title, null); assert.equal(result.untrusted, true);
  }
  assert.equal((await fetchWebPage({ url: 'https://example.com/', max_chars: 40000 }, make('text/plain; charset=windows-1252', Buffer.from([0x80, 0xe9])))).text, '€é');
  assert.equal((await fetchWebPage({ url: 'https://example.com/' }, make('text/plain; charset=iso-8859-1', Buffer.from([0x80])))).text, '€');
  for (const mime of [undefined, 'application/pdf', 'image/png']) await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, make(mime, Buffer.from('x'))), { code: 'UNSUPPORTED_CONTENT_TYPE' });
  await assert.rejects(fetchWebPage({ url: 'https://example.com/' }, make('text/plain', Buffer.from('  '))), { code: 'EMPTY_CONTENT' });
});

test('network and confirmation errors use safe typed errors', async () => {
  const options = { budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [] };
  await assert.rejects(fetchWebPage({ url: 'http://127.0.0.1/' }, options), err => err instanceof WebFetchError && err.code === 'BLOCKED_DESTINATION');
  await assert.rejects(fetchWebPage({ url: 'https://example.com/?secret=x' }, { ...options, confirmRequest: async () => { throw new Error('sensitive internal detail'); } }), err => err instanceof WebFetchError && err.code === 'CONFIRMATION_REQUIRED' && !err.message.includes('sensitive'));
});
