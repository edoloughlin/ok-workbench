'use strict';

// Provider fields are deliberately interpreted only where their semantics are
// known. Null means unavailable; it is never silently converted to zero.
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function result(inputUncached, cacheRead, cacheWrite, output, reasoning, totalTokens) {
  const parts = [inputUncached, cacheRead, cacheWrite, output];
  const sum = parts.every(value => value !== null) ? parts.reduce((a, b) => a + b, 0) : null;
  const safeSum = Number.isSafeInteger(sum) ? sum : null;
  const knownParts = parts.filter(value => value !== null);
  const lowerBound = knownParts.length ? knownParts.reduce((a, b) => a + b, 0) : null;
  const total = totalTokens ?? safeSum ?? (Number.isSafeInteger(lowerBound) ? lowerBound : null);
  const mismatch = totalTokens !== null && safeSum !== null && totalTokens !== safeSum;
  const invalidReasoning = reasoning !== null && output !== null && reasoning > output;
  return {
    inputUncached, cacheRead, cacheWrite, output,
    reasoning: invalidReasoning ? null : reasoning,
    totalTokens: total,
    usageCoverage: total === null && parts.every(value => value === null) ? 'unavailable'
      : safeSum !== null && total !== null && !mismatch && !invalidReasoning ? 'complete' : 'partial',
    mismatch: mismatch || invalidReasoning,
  };
}

// OpenAI prompt_tokens includes cached_tokens; completion_tokens includes
// reasoning_tokens. Cache creation is not separately reported by this API.
function normalizeOpenAI(usage) {
  if (!usage || typeof usage !== 'object') return result(null, null, null, null, null, null);
  const input = count(usage.prompt_tokens);
  const output = count(usage.completion_tokens);
  const cache = count(usage.prompt_tokens_details?.cached_tokens);
  const reasoning = count(usage.completion_tokens_details?.reasoning_tokens);
  const total = count(usage.total_tokens);
  if (input !== null && cache !== null && cache <= input) {
    return result(input - cache, cache, 0, output, reasoning, total);
  }
  // An absent or inconsistent cache field does not establish a disjoint
  // breakdown. Preserve the provider total, or the inclusive input + output.
  const inclusive = input !== null && Number.isSafeInteger(input + (output ?? 0)) ? input + (output ?? 0) : null;
  const normalized = result(null, null, null, output, reasoning, total ?? inclusive);
  if (cache !== null && input !== null && cache > input) normalized.mismatch = true;
  return normalized;
}

// Anthropic reports uncached input and cache creation/read separately. Fields
// not present remain unknown: compatibility endpoints may omit cache counters.
function normalizeAnthropic(usage) {
  if (!usage || typeof usage !== 'object') return result(null, null, null, null, null, null);
  return result(count(usage.input_tokens), count(usage.cache_read_input_tokens),
    count(usage.cache_creation_input_tokens), count(usage.output_tokens), null, count(usage.total_tokens));
}

// Responses and Google include cached tokens in their reported input. Pi's
// provider event format supplies disjoint input/cache fields; SDK defaults are
// only accepted when the adapter emits an actual provider usage event.
function normalizeResponses(u) {
  if (!u || typeof u !== 'object') return result(null,null,null,null,null,null);
  return normalizeOpenAI({prompt_tokens:u.input_tokens, completion_tokens:u.output_tokens,
    prompt_tokens_details:{cached_tokens:u.input_tokens_details?.cached_tokens},
    completion_tokens_details:{reasoning_tokens:u.output_tokens_details?.reasoning_tokens}, total_tokens:u.total_tokens});
}
function normalizeGoogle(u) {
  if (!u || typeof u !== 'object') return result(null,null,null,null,null,null);
  const candidates = count(u.candidatesTokenCount), reasoning = count(u.thoughtsTokenCount);
  const output = candidates !== null && reasoning !== null && Number.isSafeInteger(candidates + reasoning) ? candidates + reasoning : null;
  return normalizeOpenAI({prompt_tokens:u.promptTokenCount, completion_tokens:output,
    prompt_tokens_details:{cached_tokens:u.cachedContentTokenCount},
    completion_tokens_details:{reasoning_tokens:reasoning}, total_tokens:u.totalTokenCount});
}
function normalizeBedrock(u) {
  if (!u || typeof u !== 'object') return result(null,null,null,null,null,null);
  return result(count(u.inputTokens),count(u.cacheReadInputTokens),count(u.cacheWriteInputTokens),count(u.outputTokens),null,count(u.totalTokens));
}
function normalizePi(u) {
  if (!u || typeof u !== 'object') return result(null,null,null,null,null,null);
  return result(count(u.input),count(u.cacheRead),count(u.cacheWrite),count(u.output),count(u.reasoning),count(u.totalTokens));
}
function normalizeUsage(format, usage) {
  switch (format) {
    case 'openai-completions': case 'mistral': return normalizeOpenAI(usage);
    case 'openai-responses': return normalizeResponses(usage);
    case 'anthropic': return normalizeAnthropic(usage);
    case 'google': return normalizeGoogle(usage);
    case 'bedrock': return normalizeBedrock(usage);
    case 'pi': case 'pi-messages': return normalizePi(usage);
    default: return result(null,null,null,null,null,null);
  }
}
module.exports = { normalizeOpenAI, normalizeAnthropic, normalizeResponses, normalizeGoogle, normalizeBedrock, normalizePi, normalizeUsage };
