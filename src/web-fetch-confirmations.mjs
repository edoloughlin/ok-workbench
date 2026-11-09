import { randomBytes } from 'node:crypto';
import { WebFetchError } from './web-fetch-errors.mjs';

// Process-local decisions are deliberately not persisted. The caller binds the
// context to the originating authenticated browser and live turn.
export class WebFetchConfirmations {
  constructor({ timeoutMs = 120_000, maxPending = 16 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.entries = new Map();
  }

  request({ browser, threadId, turnId, toolCallId, hop, url, previousOrigin = null, signal, emit }) {
    if (!browser || !threadId || !turnId || !toolCallId || !Number.isInteger(hop) || typeof url !== 'string' || typeof emit !== 'function') throw new WebFetchError('CONFIRMATION_REQUIRED', 'Confirmation is unavailable');
    if (signal?.aborted) return Promise.reject(new WebFetchError('CANCELLED', 'Fetch cancelled'));
    if ([...this.entries.values()].filter(entry => !entry.done).length >= this.maxPending) return Promise.reject(new WebFetchError('RESOURCE_LIMIT', 'Too many pending confirmations'));
    // Keep replay tombstones bounded even if requests complete rapidly.
    while (this.entries.size >= this.maxPending * 2) {
      const oldest = [...this.entries].find(([, entry]) => entry.done);
      if (!oldest) break;
      clearTimeout(oldest[1].cleanup);
      this.entries.delete(oldest[0]);
    }
    const id = randomBytes(24).toString('base64url');
    const expires = Date.now() + this.timeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { browser, threadId, turnId, toolCallId, hop, url, expires, done: false };
      let timer;
      const finish = outcome => {
        if (entry.done) return false;
        entry.done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        // Retain a bounded-lived tombstone for duplicate decisions.
        entry.cleanup = setTimeout(() => this.entries.delete(id), this.timeoutMs);
        entry.cleanup.unref?.();
        try { emit('web_fetch.confirmation_resolved', { request_id: id, outcome }); } catch { /* UI disconnects do not grant approval. */ }
        if (outcome === 'allow') resolve();
        else if (outcome === 'deny') reject(new WebFetchError('USER_DENIED', 'Fetch denied'));
        else if (outcome === 'expired') reject(new WebFetchError('CONFIRMATION_EXPIRED', 'Fetch confirmation expired'));
        else reject(new WebFetchError('CANCELLED', 'Fetch cancelled'));
        return true;
      };
      const abort = () => finish('cancelled');
      entry.finish = finish;
      this.entries.set(id, entry);
      timer = setTimeout(() => finish('expired'), this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      try {
        emit('web_fetch.confirmation_required', { request_id: id, thread_id: threadId, turn_id: turnId, tool_call_id: toolCallId, url, method: 'GET', hop, previous_origin: previousOrigin, expires_at: new Date(expires).toISOString() });
      } catch { finish('cancelled'); }
    });
  }

  decide({ id, browser, threadId, turnId, decision }) {
    if (!['allow', 'deny'].includes(decision)) return 400;
    const entry = this.entries.get(id);
    if (!entry || entry.browser !== browser || entry.threadId !== threadId || entry.turnId !== turnId) return 404;
    if (entry.done) return 409;
    if (Date.now() >= entry.expires) { entry.finish('expired'); return 409; }
    return entry.finish(decision) ? 204 : 409;
  }

  cancelAll() {
    for (const entry of this.entries.values()) {
      if (!entry.done) entry.finish('cancelled');
      clearTimeout(entry.cleanup);
    }
    this.entries.clear();
  }
}
