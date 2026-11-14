import { randomUUID } from 'node:crypto';

const noop = async () => {};
const disabled = Object.freeze({ start: noop, usage: noop, finish: noop, fail: async error => error });

function accountingFailure() {
  // SDK retry classifiers also traverse Error.cause. Keep provider status
  // fields and causes off this error so accounting failures cannot retry.
  return Object.assign(new Error('Usage accounting is unavailable'), {
    code: 'USAGE_STORE_UNAVAILABLE', usageAccountingFailure: true,
  });
}

// Adapters invoke start immediately before the physical inference dispatch.
// The observer never receives provider payloads, endpoints, or error bodies.
export function createInferenceObserver(options, model) {
  if (typeof options?.onInferenceAttempt !== 'function') return disabled;
  let active = null;
  let previousRequestId = null;
  let attempt = 0;
  let failed = null;
  const check = () => { if (failed) throw failed; };
  async function notify(callback, value) {
    check();
    try { return await callback?.(value); }
    catch (error) { failed = accountingFailure(error); throw failed; }
  }
  const observer = {
    async start(transport) {
      check();
      // Starting a retry closes its failed predecessor, even when the SDK does
      // not expose a separate failure callback before its retry middleware.
      if (active) await observer.finish('failed');
      const requestId = randomUUID();
      const metadata = {
        requestId, provider: model.provider, model: model.id, api: model.api,
        transport, attempt: ++attempt, retryOfRequestId: previousRequestId,
      };
      const callbacks = await notify(options.onInferenceAttempt, metadata);
      active = { requestId: callbacks?.requestId || requestId, callbacks };
      previousRequestId = active.requestId;
      return { requestId: active.requestId };
    },
    async usage(usage, format = 'pi') {
      check();
      if (active && usage != null) await notify(active.callbacks?.onUsage, { usage, format });
    },
    async finish(status = 'completed') {
      check();
      if (!active) return;
      if (!['completed', 'failed', 'aborted'].includes(status)) throw new TypeError('Invalid inference outcome');
      const current = active;
      active = null;
      await notify(current.callbacks?.onFinish, { status });
    },
    async fail(error) {
      if (error?.usageAccountingFailure) { failed = error; throw error; }
      check();
      await observer.finish(options.signal?.aborted || error?.name === 'AbortError' ? 'aborted' : 'failed');
      return error;
    },
  };
  return observer;
}
