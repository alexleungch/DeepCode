import type { Usage } from '../providers/types.js';
import type { PriceEntry } from '../config/types.js';

/** Cache hit rate (0-1); returns null when it cannot be determined */
export function cacheHitRate(u: Usage): number | null {
  const hit = u.cacheReadTokens ?? u.promptCacheHitTokens ?? u.cachedContentTokenCount ?? 0;
  if (hit <= 0 || u.inputTokens <= 0) return null;
  return hit / u.inputTokens;
}

/** Estimated savings from cache (USD): hit portion priced at the cacheRead rate rather than the input rate */
export function cacheSavingsUsd(price: PriceEntry, u: Usage): number {
  const hit = u.cacheReadTokens ?? u.promptCacheHitTokens ?? u.cachedContentTokenCount ?? 0;
  const discount = price.input - (price.cacheRead ?? price.input);
  return (hit * discount) / 1_000_000;
}

/** Aggregate hit rate (across multiple requests) */
export function aggregateCacheHitRate(items: { inputTokens: number; cacheReadTokens?: number; promptCacheHitTokens?: number; cachedContentTokenCount?: number }[]): number | null {
  let hit = 0;
  let total = 0;
  for (const i of items) {
    hit += i.cacheReadTokens ?? i.promptCacheHitTokens ?? i.cachedContentTokenCount ?? 0;
    total += i.inputTokens;
  }
  if (hit <= 0 || total <= 0) return null;
  return hit / total;
}
