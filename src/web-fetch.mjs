import { Worker } from 'node:worker_threads';
import { validateWebUrl, resolvePublicAddresses, requestPublicUrl } from './web-fetch-network.mjs';
import { WebFetchError } from './web-fetch-errors.mjs';
export { WebFetchError } from './web-fetch-errors.mjs';
const error = (code, message) => new WebFetchError(code, message);
const cancelled = () => error('CANCELLED', 'Fetch cancelled');
const limit = () => error('RESOURCE_LIMIT', 'Web fetch resource limit reached');

// All callers in this process share these reservations.
let active = 0; let pending = 0; let workers = 0;
const activeQueue = []; const workerQueue = [];
export function createWebFetchBudget() { return { attempts: 0, requests: 0, bytes: 0 }; }
function reservePending() {
  if (pending >= 16) throw limit();
  pending++;
  let released = false;
  return () => { if (!released) { released = true; pending--; } };
}
function acquire(kind, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  const queue = kind === 'worker' ? workerQueue : activeQueue;
  const available = () => kind === 'worker' ? workers < 2 : active < 4;
  const grant = () => {
    if (kind === 'worker') workers++; else active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'worker') workers--; else active--;
      while (queue.length && available()) queue.shift()();
    };
  };
  if (available()) return Promise.resolve(grant());
  let releasePending;
  try { releasePending = reservePending(); } catch (err) { return Promise.reject(err); }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); releasePending(); const index = queue.indexOf(ready); if (index >= 0) queue.splice(index, 1); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const ready = () => { cleanup(); resolve(grant()); };
    timer = setTimeout(() => { cleanup(); reject(limit()); }, 10_000);
    signal.addEventListener('abort', abort, { once: true });
    queue.push(ready);
    if (signal.aborted) abort();
  });
}

function contentType(value) {
  if (typeof value !== 'string') throw error('UNSUPPORTED_CONTENT_TYPE', 'Unsupported content type');
  const [raw, ...parameters] = value.split(';'); const mime = raw.trim().toLowerCase();
  if (!['text/html', 'text/plain', 'text/markdown', 'application/json'].includes(mime) && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime)) throw error('UNSUPPORTED_CONTENT_TYPE', 'Unsupported content type');
  const charsetParameters = parameters.map(item => item.trim()).filter(item => /^charset(?:\s|=|$)/i.test(item));
  if (charsetParameters.length > 1) throw error('UNSUPPORTED_ENCODING', 'Unsupported character encoding');
  const declaredCharset = charsetParameters[0]?.match(/^charset\s*=\s*(?:"([^"\s]+)"|([^"\s]+))$/i);
  if (charsetParameters.length && !declaredCharset) throw error('UNSUPPORTED_ENCODING', 'Unsupported character encoding');
  const charset = (declaredCharset?.[1] || declaredCharset?.[2] || 'utf-8').toLowerCase();
  if (!['utf-8', 'utf8', 'windows-1252', 'iso-8859-1'].includes(charset)) throw error('UNSUPPORTED_ENCODING', 'Unsupported character encoding');
  return { mime, charset };
}

async function extract(result, maxChars, signal) {
  const release = await acquire('worker', signal);
  let worker;
  try {
    const { mime, charset } = contentType(result.contentType);
    const bytes = Uint8Array.from(result.bytes);
    worker = new Worker(new URL('./web-fetch-text-worker.mjs', import.meta.url), {
      workerData: { bytes, contentType: mime, charset, maxChars },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    const value = await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, result) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); err ? reject(err) : resolve(result); };
      const abort = () => finish(cancelled());
      const timer = setTimeout(() => finish(error('TIMEOUT', 'Extraction timed out')), 2000);
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', data => finish(null, data));
      worker.once('error', err => finish(error(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'RESOURCE_LIMIT' : 'EXTRACTION_ERROR', 'Text extraction failed')));
      worker.once('exit', code => { if (code !== 0) finish(error('EXTRACTION_ERROR', 'Text extraction failed')); });
      if (signal.aborted) abort();
    });
    if (value?.error) throw error(['EMPTY_CONTENT', 'UNSUPPORTED_ENCODING'].includes(value.error) ? value.error : 'EXTRACTION_ERROR', 'Text extraction failed');
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'text,title,truncated' || typeof value.text !== 'string' || !value.text.trim() || value.text.length > maxChars || typeof value.truncated !== 'boolean' || !(value.title === null || typeof value.title === 'string' && value.title.length <= 300)) throw error('EXTRACTION_ERROR', 'Text extraction failed');
    return { title: value.title, text: value.text, truncated: value.truncated, content_type: mime };
  } finally { if (worker) await worker.terminate(); release(); }
}

export async function fetchWebPage(params, options = {}) {
  const { signal: caller, confirmRequest, budget } = options;
  if (!budget) throw error('CONFIRMATION_REQUIRED', 'Interactive confirmation is required');
  if (++budget.attempts > 8) throw limit();
  if (typeof confirmRequest !== 'function') throw error('CONFIRMATION_REQUIRED', 'Interactive confirmation is required');
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['url', 'max_chars'].includes(key))) throw error('INVALID_ARGUMENT', 'Invalid web fetch arguments');
  const maxChars = Object.hasOwn(params, 'max_chars') ? params.max_chars : 20000;
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 40000) throw error('INVALID_ARGUMENT', 'Invalid web fetch arguments');
  if (caller?.aborted) throw cancelled();
  const absolute = AbortSignal.timeout(180_000);
  const overall = caller ? AbortSignal.any([caller, absolute]) : absolute;
  let activeMs = 15_000;
  let current = validateWebUrl(params.url); const initial = current.href; const seen = new Set(); let previousOrigin = null;
  for (let hop = 0; hop <= 5; hop++) {
    if (overall.aborted) throw caller?.aborted ? cancelled() : error('TIMEOUT', 'Fetch timed out');
    if (seen.has(current.href)) throw error('REDIRECT_ERROR', 'Redirect loop');
    if (budget.requests >= 12) throw limit();
    seen.add(current.href);
    const releasePending = reservePending();
    try { await confirmRequest({ url: current.href, hop, previousOrigin, signal: overall }); }
    catch (err) {
      if (caller?.aborted) throw cancelled();
      if (absolute.aborted) throw error('TIMEOUT', 'Fetch timed out');
      if (err instanceof WebFetchError) throw err;
      throw error('CONFIRMATION_REQUIRED', 'Interactive confirmation is unavailable');
    } finally { releasePending(); }
    if (overall.aborted) throw caller?.aborted ? cancelled() : error('TIMEOUT', 'Fetch timed out');
    let release;
    try { release = await acquire('active', overall); }
    catch (err) {
      if (caller?.aborted) throw cancelled();
      if (absolute.aborted) throw error('TIMEOUT', 'Fetch timed out');
      throw err;
    }
    const started = performance.now();
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(activeMs)));
    const workSignal = AbortSignal.any([overall, timeout]);
    let response;
    try {
      // Reserve before DNS, including when another parallel invocation used
      // the last slot while this call was waiting for approval or capacity.
      if (budget.requests >= 12) throw limit();
      budget.requests++;
      const records = await (options.resolver || resolvePublicAddresses)(current, { signal: workSignal });
      if (workSignal.aborted) throw cancelled();
      response = await (options.transport || requestPublicUrl)(current, records, { signal: workSignal, onBytes: count => { budget.bytes += count; if (budget.bytes > 8 * 1024 * 1024) throw limit(); } });
      if (response.status >= 200 && response.status < 300) {
        const extracted = await extract(response, maxChars, workSignal);
        if (workSignal.aborted) throw cancelled();
        return { url: initial, final_url: current.href, status: response.status, ...extracted, fetched_at: new Date(options.clock ? options.clock() : Date.now()).toISOString(), untrusted: true };
      }
    } catch (err) {
      if (caller?.aborted) throw cancelled();
      if (timeout.aborted || absolute.aborted) throw error('TIMEOUT', 'Fetch timed out');
      if (err instanceof WebFetchError) throw err;
      throw error('NETWORK_ERROR', 'Web request failed');
    } finally { activeMs -= performance.now() - started; release(); }
    if (hop === 5 || !Array.isArray(response.locations) || response.locations.length !== 1 || !response.locations[0] || response.locations[0].length > 4096) throw error('REDIRECT_ERROR', 'Invalid redirect');
    let next;
    try { next = validateWebUrl(response.locations[0], current); } catch (err) { if (err.code === 'BLOCKED_DESTINATION') throw err; throw error('REDIRECT_ERROR', 'Invalid redirect'); }
    if (current.protocol === 'https:' && next.protocol === 'http:') throw error('REDIRECT_ERROR', 'Insecure redirect');
    previousOrigin = current.origin; current = next;
    if (activeMs <= 0) throw error('TIMEOUT', 'Fetch timed out');
  }
  throw error('REDIRECT_ERROR', 'Invalid redirect');
}
