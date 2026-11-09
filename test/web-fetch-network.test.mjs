import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateWebUrl, isPublicAddress, assertPublicAddresses, resolvePublicAddresses, requestPublicUrl } from '../src/web-fetch-network.mjs';
import { fetchWebPage, createWebFetchBudget } from '../src/web-fetch.mjs';
import { manualClock, settle } from './fixtures/web-fetch/manual-clock.mjs';

const noInterfaces = () => ({});

test('normalizes URLs and rejects forbidden targets before lookup', () => {
  assert.equal(validateWebUrl('https://EXAMPLE.com.:443/path?q=1#x').href, 'https://example.com/path?q=1');
  for (const value of ['http://localhost/', 'https://host.local/', 'http://127.1/', 'http://0x7f000001/', 'http://[::ffff:8.8.8.8]/', 'http://10.0.0.1/']) {
    assert.throws(() => validateWebUrl(value), { code: 'BLOCKED_DESTINATION' }, value);
  }
  for (const value of ['file:///etc/passwd', 'https://user:pw@example.com/', 'https://example.com:444/', 'https://example.com/has space', 'https://example.com/\\x']) {
    assert.throws(() => validateWebUrl(value), { code: 'INVALID_ARGUMENT' }, value);
  }
});

test('rejects special-purpose ranges and permits public unicast', () => {
  for (const value of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001:db8::1', '2002::1', '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1']) assert.equal(isPublicAddress(value), false, value);
  for (const value of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(value), true, value);
});

test('address deny tables reject CIDR boundary addresses', () => {
  const boundaries = [
    ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'], ['100.64.0.0', '100.127.255.255'],
    ['127.0.0.0', '127.255.255.255'], ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.255'], ['192.0.2.0', '192.0.2.255'], ['192.88.99.0', '192.88.99.255'],
    ['192.168.0.0', '192.168.255.255'], ['198.18.0.0', '198.19.255.255'], ['198.51.100.0', '198.51.100.255'],
    ['203.0.113.0', '203.0.113.255'], ['224.0.0.0', '239.255.255.255'], ['240.0.0.0', '255.255.255.255'],
    ['2001::', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'], ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], ['3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ];
  for (const [first, last] of boundaries) { assert.equal(isPublicAddress(first), false, first); assert.equal(isPublicAddress(last), false, last); }
  for (const address of ['9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '198.17.255.255', '198.20.0.0', '2001:200::', '3fff:1000::']) assert.equal(isPublicAddress(address), true, address);
});

test('URL policy canonicalizes IDNA and rejects alternate local address spellings', () => {
  assert.equal(validateWebUrl('https://bücher.de.:443/a?b=2&a=1#fragment').href, 'https://xn--bcher-kva.de/a?b=2&a=1');
  for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:808:808]/', 'http://169.254.169.254/', 'https://x.home.arpa/', 'https://x.invalid/', 'https://x.test/']) assert.throws(() => validateWebUrl(url), { code: 'BLOCKED_DESTINATION' }, url);
  for (const url of ['ftp://example.com/', 'https://user@example.com/', 'http://example.com:443/', 'https://example.com/\nsecret', 'https://[fe80::1%25eth0]/']) assert.throws(() => validateWebUrl(url), { code: 'INVALID_ARGUMENT' }, url);
});

test('rejects mixed answers and locally assigned global addresses', () => {
  assert.doesNotThrow(() => assertPublicAddresses([{ address: '8.8.8.8', family: 4 }], noInterfaces));
  assert.throws(() => assertPublicAddresses(['8.8.8.8', '127.0.0.1'], noInterfaces), { code: 'BLOCKED_DESTINATION' });
  assert.throws(() => assertPublicAddresses(['8.8.8.8'], () => ({ eth0: [{ address: '8.8.8.8' }] })), { code: 'BLOCKED_DESTINATION' });
  assert.throws(() => assertPublicAddresses(['8.8.8.8'], () => { throw new Error('unavailable'); }), { code: 'BLOCKED_DESTINATION' });
});

test('local interface comparison normalizes mapped and scoped addresses and fails closed', async () => {
  const mapped = () => ({ eth0: [{ address: '::ffff:8.8.8.8' }] });
  const scoped = () => ({ eth0: [{ address: '2606:4700:4700:0:0:0:0:1111%eth0' }] });
  assert.throws(() => assertPublicAddresses(['8.8.8.8'], mapped), { code: 'BLOCKED_DESTINATION' });
  assert.throws(() => assertPublicAddresses(['2606:4700:4700::1111'], scoped), { code: 'BLOCKED_DESTINATION' });
  assert.throws(() => assertPublicAddresses(['8.8.8.8'], () => ({ eth0: [{ address: 'malformed' }] })), { code: 'BLOCKED_DESTINATION' });
  await assert.rejects(resolvePublicAddresses(validateWebUrl('https://8.8.8.8/'), { interfaces: mapped }), { code: 'BLOCKED_DESTINATION' });
  await assert.rejects(resolvePublicAddresses(validateWebUrl('https://example.com/'), { interfaces: mapped, resolver: async () => [{ address: '8.8.8.8', family: 4 }] }), { code: 'BLOCKED_DESTINATION' });
});

test('native DNS failures remain internal causes and never enter public messages', async () => {
  const cause = new Error('private-host.internal 192.168.0.1 token=secret');
  await assert.rejects(resolvePublicAddresses(validateWebUrl('https://example.com/'), { interfaces: noInterfaces, resolver: async () => { throw cause; } }), error => error.code === 'DNS_ERROR' && error.cause === cause && !error.message.includes('secret') && !JSON.stringify(error).includes('secret'));
});

test('DNS fails closed for malformed resolver records', async () => {
  const url = validateWebUrl('https://example.com/');
  for (const answer of [[{ address: '8.8.8.8' }], [{ address: '8.8.8.8', family: 6 }], ['8.8.8.8'], [{ address: '8.8.8.8', family: 'IPv4' }]]) {
    await assert.rejects(resolvePublicAddresses(url, { interfaces: noInterfaces, resolver: async () => answer }), { code: 'BLOCKED_DESTINATION' });
  }
});

test('cancelled DNS operations retain process-wide reservations until lookup settles', async () => {
  const url = validateWebUrl('https://example.com/');
  const releases = []; const controllers = Array.from({ length: 4 }, () => new AbortController());
  const resolver = () => new Promise(resolve => releases.push(resolve));
  const pending = controllers.map(controller => resolvePublicAddresses(url, { interfaces: noInterfaces, signal: controller.signal, resolver }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 4);
  controllers.forEach(controller => controller.abort());
  await Promise.all(pending.map(promise => assert.rejects(promise, { code: 'CANCELLED' })));
  await assert.rejects(resolvePublicAddresses(url, { interfaces: noInterfaces, resolver }), { code: 'RESOURCE_LIMIT' });
  releases.forEach(resolve => resolve([{ address: '8.8.8.8', family: 4 }]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await resolvePublicAddresses(url, { interfaces: noInterfaces, resolver: async () => [{ address: '8.8.8.8', family: 4 }] }), [{ address: '8.8.8.8', family: 4 }]);
});

test('interface snapshot is checked again immediately before connection', async () => {
  let snapshots = 0; let connected = false;
  const interfaces = () => ++snapshots === 1 ? {} : { eth0: [{ address: '8.8.8.8' }] };
  const url = validateWebUrl('https://example.com/');
  const records = await resolvePublicAddresses(url, { interfaces, resolver: async () => [{ address: '8.8.8.8', family: 4 }] });
  const original = https.request;
  try {
    https.request = () => { connected = true; throw new Error('must not connect'); };
    await assert.rejects(requestPublicUrl(url, records, { interfaces }), { code: 'BLOCKED_DESTINATION' });
    assert.equal(snapshots, 2); assert.equal(connected, false);
  } finally { https.request = original; }
});

test('production transport supplies a pinned lookup and preserves the HTTPS identity', async () => {
  const original = https.request; let captured;
  try {
    https.request = (url, options, receive) => {
      captured = { url, options };
      const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
        const response = new PassThrough(); response.statusCode = 200;
        response.headers = { 'content-type': 'text/plain' }; response.rawHeaders = ['Content-Type', 'text/plain'];
        receive(response); response.end('source');
      };
      return req;
    };
    const url = validateWebUrl('https://example.com/path');
    const result = await requestPublicUrl(url, [{ address: '8.8.8.8', family: 4 }], { interfaces: noInterfaces });
    assert.equal(result.bytes.toString(), 'source');
    assert.equal(captured.url.hostname, 'example.com');
    assert.equal(captured.options.agent, false);
    assert.equal(captured.options.rejectUnauthorized, undefined);
    assert.equal(captured.options.servername, undefined);
    assert.equal(captured.options.headers['accept-encoding'], 'identity');
    let answer; captured.options.lookup('example.com', {}, (err, address, family) => { assert.ifError(err); answer = { address, family }; });
    assert.deepEqual(answer, { address: '8.8.8.8', family: 4 });
    captured.options.lookup('example.com', { all: true }, (err, addresses) => { assert.ifError(err); answer = addresses; });
    assert.deepEqual(answer, [{ address: '8.8.8.8', family: 4 }]);
    captured.options.lookup('example.com', (err, address, family) => { assert.ifError(err); answer = { address, family }; });
    assert.deepEqual(answer, { address: '8.8.8.8', family: 4 });
  } finally { https.request = original; }
});

test('pinned production HTTP transport reaches an injected local connector with original Host', async () => {
  const server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end(request.headers.host); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = http.request; const proxy = process.env.HTTP_PROXY; let pinned; let lookups = 0;
  try {
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    // This test-only connector redirects the socket to the fixture after the
    // production lookup selects its validated address; production policy stays intact.
    http.request = (url, options, receive) => original(url, {
      ...options, port: server.address().port, headers: { ...options.headers, host: url.host },
      lookup(host, lookupOptions, callback) {
        lookups++;
        options.lookup(host, lookupOptions, (err, address, family) => {
          if (err) return callback(err);
          pinned = Array.isArray(address) ? address : [{ address, family }];
          return lookupOptions.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
        });
      },
    }, receive);
    const result = await requestPublicUrl(validateWebUrl('http://example.com/path'), [{ address: '8.8.8.8', family: 4 }], { interfaces: noInterfaces });
    assert.equal(result.bytes.toString(), 'example.com');
    assert.equal(lookups, 1);
    assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }]);
  } finally {
    http.request = original;
    if (proxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = proxy;
    await new Promise(resolve => server.close(resolve));
  }
});

test('redirects use independent GET requests without cookies or referrers', async () => {
  const headers = [];
  const server = http.createServer((request, response) => {
    headers.push({ method: request.method, ...request.headers });
    if (request.url === '/start') { response.writeHead(302, { location: '/final', 'set-cookie': 'session=private' }); response.end('discarded'); }
    else { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('source'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = http.request;
  try {
    http.request = (url, options, receive) => original(url, { ...options, port: server.address().port, headers: { ...options.headers, host: url.host }, lookup(host, lookupOptions, callback) {
      options.lookup(host, lookupOptions, err => {
        if (err) return callback(err);
        return lookupOptions.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
      });
    } }, receive);
    const approvals = [];
    const result = await fetchWebPage({ url: 'http://example.com/start' }, {
      budget: createWebFetchBudget(), confirmRequest: async ({ url }) => approvals.push(url),
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: (url, records, options) => requestPublicUrl(url, records, { ...options, interfaces: noInterfaces }),
    });
    assert.equal(result.text, 'source'); assert.deepEqual(approvals, ['http://example.com/start', 'http://example.com/final']);
    assert.equal(headers.length, 2);
    for (const item of headers) {
      assert.equal(item.method, 'GET'); assert.equal(item.host, 'example.com'); assert.equal(item.cookie, undefined); assert.equal(item.authorization, undefined); assert.equal(item.referer, undefined);
      assert.equal(item['user-agent'], 'OK-Workbench/1.0 web-fetch'); assert.equal(item['accept-encoding'], 'identity');
    }
  } finally { http.request = original; await new Promise(resolve => server.close(resolve)); }
});

test('production transport rejects oversized, compressed and unsuccessful responses', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/declared') { response.writeHead(200, { 'content-length': String(2 * 1024 * 1024 + 1) }); return response.end(); }
    if (request.url === '/stream') { response.writeHead(200, { 'content-type': 'text/plain' }); return response.end(Buffer.alloc(2 * 1024 * 1024 + 1)); }
    if (request.url === '/gzip') { response.writeHead(200, { 'content-encoding': 'gzip' }); return response.end('not decoded'); }
    if (request.url === '/empty-encoding') { response.writeHead(200, { 'content-encoding': '' }); return response.end('text'); }
    if (request.url === '/headers') { response.writeHead(200, { 'x-large': 'x'.repeat(17000) }); return response.end('body'); }
    response.writeHead(Number(request.url.slice(1)) || 403); response.end('private body');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = http.request;
  try {
    http.request = (url, options, receive) => original(url, { ...options, port: server.address().port, lookup(host, lookupOptions, callback) {
      options.lookup(host, lookupOptions, err => {
        if (err) return callback(err);
        return lookupOptions.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
      });
    } }, receive);
    const records = [{ address: '8.8.8.8', family: 4 }];
    for (const [route, code] of [['declared', 'RESPONSE_TOO_LARGE'], ['stream', 'RESPONSE_TOO_LARGE'], ['gzip', 'UNSUPPORTED_ENCODING'], ['empty-encoding', 'UNSUPPORTED_ENCODING'], ['headers', 'NETWORK_ERROR'], ['300', 'HTTP_ERROR'], ['304', 'HTTP_ERROR'], ['403', 'HTTP_ERROR'], ['404', 'HTTP_ERROR'], ['429', 'HTTP_ERROR'], ['500', 'HTTP_ERROR']]) {
      await assert.rejects(requestPublicUrl(validateWebUrl(`http://example.com/${route}`), records, { interfaces: noInterfaces }), error => error.code === code && !error.message.includes('private body') && (code !== 'HTTP_ERROR' || error.status === Number(route)));
    }
  } finally { http.request = original; await new Promise(resolve => server.close(resolve)); }
});

test('stalled headers and bodies respect the invocation active-work deadline', async t => {
  const clock = manualClock(t); let ready;
  const server = http.createServer((request, response) => {
    if (request.url === '/body') { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('partial'); }
    else ready.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalRequest = http.request;
  try {
    http.request = (url, options, receive) => originalRequest(url, { ...options, port: server.address().port, lookup(host, lookupOptions, callback) {
      options.lookup(host, lookupOptions, err => {
        if (err) return callback(err);
        return lookupOptions.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
      });
    } }, receive);
    for (const path of ['/headers', '/body']) {
      ready = Promise.withResolvers(); let finished = false;
      const rejected = assert.rejects(fetchWebPage({ url: `http://example.com${path}` }, {
        budget: createWebFetchBudget(), confirmRequest: async () => {}, resolver: async () => [{ address: '8.8.8.8', family: 4 }],
        transport: (url, records, options) => requestPublicUrl(url, records, {
          ...options, interfaces: noInterfaces,
          onBytes: count => { options.onBytes(count); ready.resolve(); },
        }),
      }), { code: 'TIMEOUT' }).then(() => { finished = true; });
      // Wait for the request/first body chunk, not an assumed socket speed.
      await ready.promise;
      clock.advance(14_999); await settle();
      assert.equal(finished, false);
      clock.advance(1); await rejected;
    }
  } finally { clock.restore(); http.request = originalRequest; await new Promise(resolve => server.close(resolve)); }
});

test('cancellation during a response body destroys the active connection', async () => {
  let responseClosed; const closed = new Promise(resolve => { responseClosed = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }); response.write('first chunk');
    response.once('close', responseClosed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = http.request; const controller = new AbortController();
  try {
    http.request = (url, options, receive) => original(url, { ...options, port: server.address().port, lookup(host, lookupOptions, callback) {
      options.lookup(host, lookupOptions, err => {
        if (err) return callback(err);
        return lookupOptions.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
      });
    } }, receive);
    const promise = requestPublicUrl(validateWebUrl('http://example.com/'), [{ address: '8.8.8.8', family: 4 }], { interfaces: noInterfaces, signal: controller.signal, onBytes: () => controller.abort() });
    await assert.rejects(promise, { code: 'CANCELLED' });
    let watchdog;
    try {
      await Promise.race([closed, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('socket was not closed')), 1000); })]);
    } finally { clearTimeout(watchdog); }
  } finally { controller.abort(); http.request = original; await new Promise(resolve => server.close(resolve)); }
});

test('TLS verifies the original hostname and sends it as SNI through a pinned connector', async t => {
  if (spawnSync('openssl', ['version']).status !== 0) return t.skip('openssl is unavailable');
  const directory = await mkdtemp(path.join(tmpdir(), 'ok-fetch-tls-'));
  let server; const original = https.request;
  try {
    const key = path.join(directory, 'key.pem'); const cert = path.join(directory, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=example.com', '-addext', 'subjectAltName=DNS:example.com'], { stdio: 'ignore' });
    assert.equal(generated.status, 0);
    const certificate = await readFile(cert); let sni;
    server = https.createServer({ key: await readFile(key), cert: certificate }, (request, response) => { sni = request.socket.servername; response.writeHead(200, { 'content-type': 'text/plain' }); response.end('verified'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    https.request = (url, options, receive) => original(url, {
      ...options, port: server.address().port, ca: certificate,
      lookup(host, lookupOptions, callback) {
        options.lookup(host, lookupOptions, (err, address, family) => {
          if (err) return callback(err);
          assert.deepEqual(Array.isArray(address) ? address : [{ address, family }], [{ address: '8.8.8.8', family: 4 }]);
          return lookupOptions.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
        });
      },
    }, receive);
    const records = [{ address: '8.8.8.8', family: 4 }];
    assert.equal((await requestPublicUrl(validateWebUrl('https://example.com/'), records, { interfaces: noInterfaces })).bytes.toString(), 'verified');
    assert.equal(sni, 'example.com');
    await assert.rejects(requestPublicUrl(validateWebUrl('https://other.example.com/'), records, { interfaces: noInterfaces }), { code: 'NETWORK_ERROR' });
  } finally {
    https.request = original;
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('DNS rejects mixed answers and settles promptly on cancellation', async () => {
  const url = validateWebUrl('https://example.com/');
  await assert.rejects(resolvePublicAddresses(url, { interfaces: noInterfaces, resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), { code: 'BLOCKED_DESTINATION' });
  const controller = new AbortController(); let resolveLookup;
  const lookup = new Promise(resolve => { resolveLookup = resolve; });
  const pending = resolvePublicAddresses(url, { interfaces: noInterfaces, signal: controller.signal, resolver: () => lookup });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  resolveLookup([{ address: '8.8.8.8', family: 4 }]);
});
