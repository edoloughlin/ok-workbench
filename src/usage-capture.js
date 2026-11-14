'use strict';
const { normalizeUsage } = require('./usage-normalization.js');

// Scope is fixed at acceptance, before navigation or later configuration can
// change it. Provider usage snapshots replace earlier snapshots, never add to it.
function createUsageCapture({ store, context }) {
  const scope = Object.freeze({ ...context });
  const onInferenceAttempt = async function (metadata = {}) {
    const request = await store.startRequest({ ...scope,
      subtask: metadata.subtask ?? scope.subtask, requestId: metadata.requestId, provider: metadata.provider ?? null,
      model: metadata.model ?? null, modelIdentitySource: metadata.provider && metadata.model ? 'runtime' : 'unknown',
      attempt: (scope.attempt ?? 1) + ((metadata.attempt ?? 1) - 1), retryOfRequestId: metadata.retryOfRequestId ?? scope.retryOfRequestId ?? null,
      validationOutcome: scope.validationOutcome ?? 'not_applicable',
    });
    onInferenceAttempt.lastRequestId = request.requestId;
    scope.onRequest?.(request.requestId);
    let raw = {}, previousFormat = null;
    return {
      requestId: request.requestId,
      async onUsage({ usage, format }) {
        if (!usage || typeof usage !== 'object') return;
        // Anthropic emits separate cumulative input and output frames. Merge
        // present fields so a later frame does not erase previously reported counts.
        raw = format === previousFormat && format === 'anthropic' ? { ...raw, ...usage } : usage;
        previousFormat = format;
        await store.checkpointRequest(request.requestId, { ...normalizeUsage(format, raw), usageSource: format === 'pi' ? 'runtime' : 'provider', normalizerVersion: 1 });
      },
      async onFinish({ status }) {
        await store.finishRequest(request.requestId, { status });
        if (status !== 'completed' && request.validationOutcome === 'pending') await store.validationRequest(request.requestId, 'not_applicable');
      },
    };
  };
  return onInferenceAttempt;
}
module.exports = { createUsageCapture };
