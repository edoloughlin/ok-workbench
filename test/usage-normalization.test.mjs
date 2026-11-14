import test from 'node:test';
import assert from 'node:assert/strict';
import normalization from '../src/usage-normalization.js';

const { normalizeOpenAI, normalizeAnthropic } = normalization;

test('OpenAI cached input and reasoning are subsets, not extra tokens', () => {
  const value = normalizeOpenAI({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 50 } });
  assert.deepEqual(value, { inputUncached: 600, cacheRead: 400, cacheWrite: 0, output: 200,
    reasoning: 50, totalTokens: 1200, usageCoverage: 'complete', mismatch: false });
});

test('Anthropic cache counters are disjoint', () => {
  const value = normalizeAnthropic({ input_tokens: 600, cache_read_input_tokens: 400,
    cache_creation_input_tokens: 100, output_tokens: 200 });
  assert.equal(value.totalTokens, 1300);
  assert.equal(value.usageCoverage, 'complete');
});

test('missing, invalid, total-only and contradictory values remain honest', () => {
  assert.equal(normalizeOpenAI(null).usageCoverage, 'unavailable');
  const totalOnly = normalizeOpenAI({ total_tokens: 900 });
  assert.equal(totalOnly.totalTokens, 900);
  assert.equal(totalOnly.inputUncached, null);
  assert.equal(totalOnly.usageCoverage, 'partial');
  const missingCache = normalizeOpenAI({ prompt_tokens: 100, completion_tokens: 20 });
  assert.equal(missingCache.totalTokens, 120);
  assert.equal(missingCache.usageCoverage, 'partial');
  const mismatch = normalizeOpenAI({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 140,
    prompt_tokens_details: { cached_tokens: 20 } });
  assert.equal(mismatch.totalTokens, 140);
  assert.equal(mismatch.mismatch, true);
  assert.equal(mismatch.usageCoverage, 'partial');
  const invalid = normalizeAnthropic({ input_tokens: -1, output_tokens: Infinity });
  assert.equal(invalid.usageCoverage, 'unavailable');
});

test('Google thoughts are an output subset and omitted thoughts stay unknown', () => {
  const value = normalization.normalizeGoogle({ promptTokenCount:1000, cachedContentTokenCount:400,
    candidatesTokenCount:150, thoughtsTokenCount:50, totalTokenCount:1200 });
  assert.equal(value.inputUncached,600); assert.equal(value.cacheRead,400);
  assert.equal(value.output,200); assert.equal(value.reasoning,50);
  assert.equal(value.totalTokens,1200); assert.equal(value.usageCoverage,'complete');
  const missing = normalization.normalizeGoogle({promptTokenCount:100, candidatesTokenCount:20, totalTokenCount:120});
  assert.equal(missing.reasoning,null); assert.equal(missing.output,null); assert.equal(missing.totalTokens,120);
  assert.equal(missing.usageCoverage,'partial');
});

test('Bedrock input and cache counters are disjoint', () => {
  const value = normalization.normalizeBedrock({ inputTokens:600, cacheReadInputTokens:400, cacheWriteInputTokens:100, outputTokens:200, totalTokens:1300 });
  assert.equal(value.inputUncached,600); assert.equal(value.cacheRead,400); assert.equal(value.cacheWrite,100);
  assert.equal(value.totalTokens,1300); assert.equal(value.usageCoverage,'complete');
});
