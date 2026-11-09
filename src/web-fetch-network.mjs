import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { WebFetchError } from './web-fetch-errors.mjs';

// Reviewed 2026-11-09 against the IANA IPv4 and IPv6 special-purpose
// registries (both last updated 2025-10-09):
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Deny non-global IPv4 entries and entire 192.0.0.0/24 and 192.88.99.0/24
// even where IANA lists exceptions. IPv6 permits only 2000::/3 and denies
// the special-purpose blocks below, including their globally reachable
// exceptions. The /3 allowlist also excludes NAT64 and SRv6 prefixes.
// Review these tables when the IANA registries change.
const DENIED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
].map(cidr => ipaddr.parseCIDR(cidr));
const DENIED_V6 = [
  '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20',
].map(cidr => ipaddr.parseCIDR(cidr));
const GLOBAL_V6 = ipaddr.parseCIDR('2000::/3');
const FORBIDDEN_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'test', 'invalid', 'example'];

export { WebFetchError as WebFetchNetworkError };
const WebFetchNetworkError = WebFetchError;
const invalid = () => new WebFetchNetworkError('INVALID_ARGUMENT', 'Invalid web fetch URL');
const blocked = () => new WebFetchNetworkError('BLOCKED_DESTINATION', 'Only public web destinations are allowed');

function addressOf(value) {
  if (typeof value !== 'string' || value.includes('%') || !net.isIP(value)) return null;
  try { return ipaddr.parse(value); } catch { return null; }
}

export function isPublicAddress(value) {
  const address = addressOf(value);
  if (!address) return false;
  if (address.kind() === 'ipv4') return !DENIED_V4.some(range => address.match(range));
  if (address.isIPv4MappedAddress()) return false;
  return address.match(GLOBAL_V6) && !DENIED_V6.some(range => address.match(range));
}

export function validateWebUrl(value, base) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\x00-\x1f\x7f\\]/u.test(value)) throw invalid();
  let url;
  try { url = base ? new URL(value, base) : new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw invalid();
  url.hash = '';
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  else if (host.endsWith('.')) { host = host.slice(0, -1); url.hostname = host; }
  if (!host || host.includes('%')) throw invalid();
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw blocked();
  } else if (!host.includes('.') || FORBIDDEN_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) throw blocked();
  if (url.href.length > 4096) throw invalid();
  return url;
}

// Call once after DNS resolution and again immediately before connecting.
// Failing interface discovery must not silently permit a local address.
export function assertPublicAddresses(records, interfaces = os.networkInterfaces) {
  if (!Array.isArray(records) || !records.length) throw blocked();
  let local;
  try {
    const snapshot = interfaces();
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid interfaces');
    local = new Set();
    for (const items of Object.values(snapshot)) {
      if (!Array.isArray(items)) throw new Error('Invalid interfaces');
      for (const item of items) {
        // Interface addresses may have a scope suffix or be IPv4-mapped.
        // Neither form is accepted as a destination, but both must still
        // exclude the corresponding address from the local-interface set.
        if (typeof item?.address !== 'string') throw new Error('Invalid interface address');
        const parsed = addressOf(item.address.split('%')[0]);
        if (!parsed) throw new Error('Invalid interface address');
        const address = parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
        local.add(address.toNormalizedString());
      }
    }
  } catch { throw blocked(); }
  for (const record of records) {
    const address = typeof record === 'string' ? record : record?.address;
    const parsed = addressOf(address);
    if (!parsed || !isPublicAddress(address) || local.has(parsed.toNormalizedString())) throw blocked();
    if (typeof record === 'object' && record.family !== undefined && record.family !== net.isIP(address)) throw blocked();
  }
}

let outstandingLookups = 0;
const cancelled = () => new WebFetchNetworkError('CANCELLED', 'Fetch cancelled');

// Keep a lookup reservation until the OS operation actually settles, even
// when the caller stops waiting. This avoids unbounded abandoned DNS work.
export async function resolvePublicAddresses(url, { signal, resolver = lookup, interfaces = os.networkInterfaces } = {}) {
  if (signal?.aborted) throw cancelled();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let records;
  if (net.isIP(host)) records = [{ address: host, family: net.isIP(host) }];
  else {
    if (outstandingLookups >= 4) throw new WebFetchNetworkError('RESOURCE_LIMIT', 'Too many DNS lookups');
    outstandingLookups++;
    const operation = Promise.resolve().then(() => resolver(host, { all: true, verbatim: true })).finally(() => { outstandingLookups--; });
    let onAbort;
    try {
      records = await Promise.race([operation, new Promise((_, reject) => {
        onAbort = () => reject(cancelled());
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      })]);
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      throw new WebFetchNetworkError('DNS_ERROR', 'Host resolution failed', { cause: error });
    } finally { signal?.removeEventListener('abort', onAbort); }
  }
  if (signal?.aborted) throw cancelled();
  if (!Array.isArray(records) || !records.length) throw new WebFetchNetworkError('DNS_ERROR', 'Host resolution failed');
  // Resolver output is an authority-bearing input to the pinned lookup.
  // Reject malformed records rather than guessing their address family.
  if (records.some(record => !record || typeof record !== 'object' || ![4, 6].includes(record.family) || net.isIP(record.address) !== record.family)) throw blocked();
  assertPublicAddresses(records, interfaces);
  return records;
}

// Uses a pinned lookup callback, never a second DNS resolution or global pool.
// The original URL supplies Host and the HTTPS server identity to Node.
export async function requestPublicUrl(url, records, { signal, interfaces = os.networkInterfaces, onBytes = () => {} } = {}) {
  if (signal?.aborted) throw cancelled();
  assertPublicAddresses(records, interfaces);
  const chosen = records[0];
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const selected = { address: typeof chosen === 'string' ? chosen : chosen.address, family: typeof chosen === 'string' ? net.isIP(chosen) : chosen.family };
  return new Promise((resolve, reject) => {
    let settled = false; let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', onAbort);
      if (error) { response?.destroy(); req.destroy(); reject(error); } else resolve(value);
    };
    const onAbort = () => finish(cancelled());
    const options = {
      method: 'GET', agent: false, maxHeaderSize: 16 * 1024,
      headers: { 'user-agent': 'OK-Workbench/1.0 web-fetch', accept: 'text/html, text/plain, text/markdown, application/json, application/*+json', 'accept-encoding': 'identity' },
      lookup(_hostname, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
      },
      ...(net.isIP(host) ? { servername: '' } : {}),
    };
    const req = (url.protocol === 'https:' ? https : http).request(url, options, incoming => {
      response = incoming;
      const status = incoming.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const locations = [];
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) if (incoming.rawHeaders[i].toLowerCase() === 'location') locations.push(incoming.rawHeaders[i + 1]);
        incoming.destroy(); req.destroy();
        return finish(null, { status, locations });
      }
      if (status < 200 || status > 299) return finish(new WebFetchNetworkError('HTTP_ERROR', `HTTP status ${status}`, { status }));
      const encoding = (incoming.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
      if (encoding !== 'identity') return finish(new WebFetchNetworkError('UNSUPPORTED_ENCODING', 'Unsupported response encoding'));
      const declared = incoming.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 2 * 1024 * 1024)) return finish(new WebFetchNetworkError('RESPONSE_TOO_LARGE', 'Response exceeds the limit'));
      const chunks = []; let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        try { onBytes(chunk.length); } catch (error) { return finish(error); }
        if (size > 2 * 1024 * 1024) return finish(new WebFetchNetworkError('RESPONSE_TOO_LARGE', 'Response exceeds the limit'));
        chunks.push(chunk);
      });
      incoming.once('end', () => {
        const result = { status, contentType: incoming.headers['content-type'], bytes: Buffer.concat(chunks, size) };
        incoming.destroy(); req.destroy();
        finish(null, result);
      });
      incoming.once('error', cause => finish(new WebFetchNetworkError('NETWORK_ERROR', 'Web request failed', { cause })));
      incoming.once('aborted', () => finish(new WebFetchNetworkError('NETWORK_ERROR', 'Web request failed')));
    });
    req.once('error', cause => finish(new WebFetchNetworkError('NETWORK_ERROR', 'Web request failed', { cause })));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort(); else req.end();
  });
}
