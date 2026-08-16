import type { PriceEntry, ProviderId } from '../config/types.js';
import type { Usage } from '../providers/types.js';
import { estimateCostUsd } from './pricing.js';

/** Normalized per-request usage event (produced by the Usage Extractor) */
export interface UsageEvent {
  ts: number;
  sessionId: string;
  provider: ProviderId;
  model: string;
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  cachedContentTokenCount?: number;
  costUsd: number;
  latencyMs: number;
  /** Whether the event was produced mid-stream (incremental) */
  partial?: boolean;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  costUsd: number;
  totalTokens: number;
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    costUsd: 0,
    totalTokens: 0,
  };
}

export function addToTotals(t: UsageTotals, e: UsageEvent): UsageTotals {
  t.requests += 1;
  t.inputTokens += e.inputTokens;
  t.outputTokens += e.outputTokens;
  t.cacheReadTokens += e.cacheReadTokens ?? 0;
  t.cacheWriteTokens += e.cacheWriteTokens ?? 0;
  t.promptCacheHitTokens += e.promptCacheHitTokens ?? 0;
  t.promptCacheMissTokens += e.promptCacheMissTokens ?? 0;
  t.costUsd = Math.round((t.costUsd + e.costUsd) * 1_000_000) / 1_000_000;
  t.totalTokens += e.inputTokens + e.outputTokens;
  return t;
}

/**
 * Session-level usage tracker (the in-memory side of the Session State Store):
 * accumulates after each generation/Tool Call for real-time reads by the status bar and /cost dashboard.
 */
export class UsageTracker {
  private totals: UsageTotals = emptyTotals();
  private events: UsageEvent[] = [];
  private onEvent?: (e: UsageEvent) => void;
  private pricing: (model: string) => PriceEntry;

  constructor(opts?: { onEvent?: (e: UsageEvent) => void; pricing?: (model: string) => PriceEntry }) {
    this.onEvent = opts?.onEvent;
    this.pricing = opts?.pricing ?? (() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
  }

  private buildEvent(sessionId: string, provider: ProviderId, model: string, usage: Usage, opts?: { requestId?: string; latencyMs?: number; partial?: boolean }): UsageEvent {
    return {
      ts: Date.now(),
      sessionId,
      provider,
      model,
      requestId: opts?.requestId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      promptCacheHitTokens: usage.promptCacheHitTokens,
      promptCacheMissTokens: usage.promptCacheMissTokens,
      cachedContentTokenCount: usage.cachedContentTokenCount,
      costUsd: estimateCostUsd(this.pricing(model), usage),
      latencyMs: opts?.latencyMs ?? 0,
      partial: opts?.partial,
    };
  }

  /** Called by the Usage Extractor: normalizes and records usage returned by the provider (including immediate cost conversion) */
  track(sessionId: string, provider: ProviderId, model: string, usage: Usage, opts?: { requestId?: string; latencyMs?: number; partial?: boolean }): UsageEvent {
    const event = this.buildEvent(sessionId, provider, model, usage, opts);
    this.events.push(event);
    addToTotals(this.totals, event);
    this.onEvent?.(event);
    return event;
  }

  /** Session end/fallback: returns all events (for persistence) */
  finalize(): UsageEvent[] {
    return this.events;
  }

  /** Builds an event without recording it (for real-time streaming to the UI; the final done track is authoritative) */
  peek(provider: ProviderId, model: string, usage: Usage, opts?: { requestId?: string; latencyMs?: number; partial?: boolean }): UsageEvent {
    return this.buildEvent('', provider, model, usage, opts);
  }

  totalsSnapshot(): UsageTotals {
    return { ...this.totals };
  }
}
