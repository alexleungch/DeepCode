import type { PriceEntry } from '../config/types.js';

/**
 * Estimate the cost of a request in USD from per-model prices.
 * - Anthropic: cacheReadTokens billed at the cacheRead rate, cacheWriteTokens at the cacheWrite rate, remaining input at the input rate
 * - DeepSeek: promptCacheHitTokens billed at the cacheRead rate (defaults to the input rate), miss at the input rate
 * - Gemini: cachedContentTokenCount counts as a hit (already included in inputTokens)
 * - Providers that do not report caching: everything billed at the input rate
 */
export function estimateCostUsd(price: PriceEntry, u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  cachedContentTokenCount?: number;
}): number {
  const hit = u.cacheReadTokens ?? u.promptCacheHitTokens ?? u.cachedContentTokenCount ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const miss = Math.max(0, u.inputTokens - hit - write);
  const perM = 1_000_000;
  const cost =
    (hit * (price.cacheRead ?? price.input)) / perM +
    (miss * price.input) / perM +
    (write * (price.cacheWrite ?? price.input)) / perM +
    (u.outputTokens * price.output) / perM;
  return roundUsd(cost);
}

export function roundUsd(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}
