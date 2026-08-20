import type { TraceMetrics } from './metrics.js';

/**
 * Quality gate: evaluates trace metrics against configurable thresholds and produces a
 * weighted 0-100 score plus a list of human-readable failures. Pure function, unit-testable.
 * Thresholds default to config.prompt.quality (see src/config/types.ts).
 */

export interface QualityThresholds {
  minToolSuccessRate: number;
  maxTurns: number;
  maxTokensPerTask: number;
  requireSettled: boolean;
}

export interface QualityReport {
  metrics: TraceMetrics;
  passed: boolean;
  /** Human-readable reasons for any failed checks (empty when passed) */
  failures: string[];
  /** Weighted 0-100 score (higher is better) */
  score: number;
}

/** Weights for the weighted score (sums to 1) */
const WEIGHTS = {
  settled: 0.25,
  toolSuccessRate: 0.25,
  turns: 0.2,
  tokens: 0.15,
  errors: 0.15,
} as const;

export function assessQuality(metrics: TraceMetrics, thresholds: QualityThresholds): QualityReport {
  const failures: string[] = [];

  if (thresholds.requireSettled && !metrics.settled) failures.push('trace ends with an unsettled streaming message (spinner stuck invariant)');
  if (metrics.toolSuccessRate < thresholds.minToolSuccessRate) {
    failures.push(`tool success rate ${(metrics.toolSuccessRate * 100).toFixed(0)}% < ${(thresholds.minToolSuccessRate * 100).toFixed(0)}% (${metrics.toolFailures}/${metrics.toolCalls} failures)`);
  }
  if (metrics.turns > thresholds.maxTurns) failures.push(`turns ${metrics.turns} > ${thresholds.maxTurns}`);
  const totalTokens = metrics.tokensIn + metrics.tokensOut;
  if (totalTokens > thresholds.maxTokensPerTask) failures.push(`tokens ${totalTokens} > ${thresholds.maxTokensPerTask}`);
  if (metrics.errors > 0) failures.push(`${metrics.errors} error event(s)`);

  // Weighted score: each dimension contributes its full weight when it passes, partial otherwise.
  let score = 0;
  score += metrics.settled ? WEIGHTS.settled * 100 : 0;
  score += (metrics.toolCalls === 0 ? 0.5 : metrics.toolSuccessRate) * WEIGHTS.toolSuccessRate * 100;
  score += Math.min(1, thresholds.maxTurns / Math.max(1, metrics.turns)) * WEIGHTS.turns * 100;
  score += Math.min(1, thresholds.maxTokensPerTask / Math.max(1, totalTokens)) * WEIGHTS.tokens * 100;
  score += (metrics.errors === 0 ? 1 : 0) * WEIGHTS.errors * 100;

  return {
    metrics,
    passed: failures.length === 0,
    failures,
    score: Math.round(score),
  };
}

/** Convenience: thresholds from a config-like object (used by the eval runner) */
export interface QualityThresholdSource {
  minToolSuccessRate: number;
  maxTurns: number;
  maxTokensPerTask: number;
  requireSettled: boolean;
}

export function thresholdsFrom(source: QualityThresholdSource): QualityThresholds {
  return {
    minToolSuccessRate: source.minToolSuccessRate,
    maxTurns: source.maxTurns,
    maxTokensPerTask: source.maxTokensPerTask,
    requireSettled: source.requireSettled,
  };
}
