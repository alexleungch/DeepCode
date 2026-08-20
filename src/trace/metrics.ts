import { replayState } from './replay.js';
import type { TraceRecord } from './types.js';

/**
 * Offline trace metrics: everything derivable from a trace without re-running the agent.
 * Consumed by the quality gate (src/trace/quality.ts) and the eval runner (src/trace/eval.ts).
 * A few hundred events compute in <10ms — safe for CI.
 */

export interface TraceMetrics {
  /** Number of turns (turn-start events) */
  turns: number;
  /** Approximate wall time (last event ts minus first, seconds → ms) */
  durationMs: number;
  /** Tool invocations (tool-start events) */
  toolCalls: number;
  /** Tool invocations that returned result.isError */
  toolFailures: number;
  /** 1 - toolFailures/toolCalls (0 when no tools were called) */
  toolSuccessRate: number;
  /** Peak number of tools in flight (parallelism evidence for the turn-budget dimension) */
  maxParallelTools: number;
  /** Approval dialogs shown */
  approvals: number;
  /** {type:'error'} events */
  errors: number;
  /** Sum of usage event input tokens */
  tokensIn: number;
  /** Sum of usage event output tokens */
  tokensOut: number;
  /** Sum of usage event cache-read tokens */
  cacheReadTokens: number;
  /** Total cost USD */
  costUsd: number;
  /** Replayed UI state is fully settled (no streaming message, not busy) — spinner-stuck invariant */
  settled: boolean;
  /** Last turn-end stopReason */
  stopReason?: string;
  /** Number of compaction events */
  compacted: number;
  /** Number of delegation events (subagent task tool) */
  delegated: number;
}

export function metricsFromTrace(record: TraceRecord): TraceMetrics {
  const events = record.events;
  let turns = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let approvals = 0;
  let errors = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let compacted = 0;
  let delegated = 0;
  let stopReason: string | undefined;

  const inFlight = new Set<string>();
  let maxParallelTools = 0;

  let firstTs: number | undefined;
  let lastTs = 0;

  for (const line of events) {
    const e = line.event;
    if (firstTs === undefined) firstTs = line.ts;
    lastTs = line.ts;

    switch (e.type) {
      case 'turn-start':
        turns++;
        break;
      case 'tool-start':
        toolCalls++;
        inFlight.add(e.callId);
        maxParallelTools = Math.max(maxParallelTools, inFlight.size);
        break;
      case 'tool-result':
        inFlight.delete(e.callId);
        if (e.result.isError) toolFailures++;
        break;
      case 'approval-request':
        approvals++;
        break;
      case 'error':
        errors++;
        break;
      case 'usage':
        tokensIn += e.usage.inputTokens;
        tokensOut += e.usage.outputTokens;
        cacheReadTokens += e.usage.cacheReadTokens ?? 0;
        costUsd += e.usage.costUsd;
        break;
      case 'turn-end':
        stopReason = e.stopReason;
        break;
      case 'compacted':
        compacted++;
        break;
      case 'delegated':
        delegated++;
        break;
      default:
        break;
    }
  }

  const toolSuccessRate = toolCalls === 0 ? 0 : 1 - toolFailures / toolCalls;
  const state = replayState(record);
  const settled = !state.busy && state.messages.every((m) => !m.streaming);

  return {
    turns,
    durationMs: firstTs === undefined ? 0 : Math.round((lastTs - firstTs) * 1000),
    toolCalls,
    toolFailures,
    toolSuccessRate,
    maxParallelTools,
    approvals,
    errors,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    costUsd,
    settled,
    stopReason,
    compacted,
    delegated,
  };
}
