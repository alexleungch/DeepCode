import { describe, it, expect } from 'vitest';
import type { EngineEvent } from '../src/events.js';
import type { TraceRecord } from '../src/trace/types.js';
import { metricsFromTrace } from '../src/trace/metrics.js';
import { assessQuality, thresholdsFrom } from '../src/trace/quality.js';

/** Build an in-memory trace from raw events (no file IO) */
function rec(events: EngineEvent[]): TraceRecord {
  return {
    meta: { v: 1, sessionId: 't', provider: 'deepseek', model: 'm', workspace: '/w', startedAt: 0 },
    events: events.map((event, i) => ({ seq: i + 1, turn: 1, ts: i * 0.1, event })),
  };
}

const start = (): EngineEvent => ({ type: 'session-start', sessionId: 't', provider: 'deepseek', model: 'm', workspace: '/w', branch: null, resumed: false });
const turnStart = (): EngineEvent => ({ type: 'turn-start', turn: 1 });
const tool = (callId: string, isError = false): EngineEvent[] => [
  { type: 'tool-start', callId, name: 'read_file', input: { path: 'a.ts' } },
  { type: 'tool-result', callId, name: 'read_file', result: { content: isError ? 'boom' : 'ok', isError }, durationMs: 5 },
];
const usage = (inputTokens: number, outputTokens: number, costUsd = 0): EngineEvent => ({
  type: 'usage',
  usage: { ts: 0, sessionId: 't', provider: 'deepseek', model: 'm', inputTokens, outputTokens, costUsd, latencyMs: 100 },
});
const done = (): EngineEvent => ({ type: 'message', message: { role: 'assistant', content: 'done' }, source: 'assistant' });
const end = (): EngineEvent => ({ type: 'session-end', sessionId: 't', reason: 'exit' });

describe('metricsFromTrace', () => {
  it('counts turns, tools, failures, tokens and settled state', () => {
    const m = metricsFromTrace(
      rec([start(), turnStart(), usage(100, 50, 0.01), ...tool('c1'), ...tool('c2', true), done(), end()]),
    );
    expect(m.turns).toBe(1);
    expect(m.toolCalls).toBe(2);
    expect(m.toolFailures).toBe(1);
    expect(m.toolSuccessRate).toBeCloseTo(0.5);
    expect(m.tokensIn).toBe(100);
    expect(m.tokensOut).toBe(50);
    expect(m.costUsd).toBeCloseTo(0.01);
    expect(m.settled).toBe(true);
    expect(m.durationMs).toBeGreaterThan(0);
  });

  it('measures peak parallelism of in-flight tools', () => {
    const m = metricsFromTrace(
      rec([
        start(),
        turnStart(),
        { type: 'tool-start', callId: 'c1', name: 'a', input: {} },
        { type: 'tool-start', callId: 'c2', name: 'b', input: {} },
        { type: 'tool-start', callId: 'c3', name: 'c', input: {} },
        { type: 'tool-result', callId: 'c1', name: 'a', result: { content: 'x' }, durationMs: 1 },
        { type: 'tool-result', callId: 'c2', name: 'b', result: { content: 'x' }, durationMs: 1 },
        { type: 'tool-result', callId: 'c3', name: 'c', result: { content: 'x' }, durationMs: 1 },
        done(),
        end(),
      ]),
    );
    expect(m.maxParallelTools).toBe(3);
  });

  it('flags an unsettled trace (spinner-stuck invariant)', () => {
    // thinking-only trace ending with session-end: busy=false but message still streaming
    const m = metricsFromTrace(
      rec([start(), turnStart(), { type: 'thinking-delta', text: 'hmm' }, end()]),
    );
    expect(m.settled).toBe(false);
  });

  it('zero-cost trace: no tools → success rate 0, no crash', () => {
    const m = metricsFromTrace(rec([start(), turnStart(), done(), end()]));
    expect(m.toolSuccessRate).toBe(0);
    expect(m.toolCalls).toBe(0);
    expect(m.settled).toBe(true);
  });
});

describe('assessQuality', () => {
  const thresholds = thresholdsFrom({ minToolSuccessRate: 0.8, maxTurns: 30, maxTokensPerTask: 150_000, requireSettled: true });

  it('passes a healthy trace', () => {
    const m = metricsFromTrace(rec([start(), turnStart(), usage(1000, 500), ...tool('c1'), done(), end()]));
    const r = assessQuality(m, thresholds);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it('fails on low tool success rate', () => {
    const m = metricsFromTrace(rec([start(), turnStart(), ...tool('c1', true), ...tool('c2', true), done(), end()]));
    const r = assessQuality(m, thresholds);
    expect(r.passed).toBe(false);
    expect(r.failures.join(' ')).toContain('tool success rate');
  });

  it('fails on unsettled trace', () => {
    const m = metricsFromTrace(rec([start(), turnStart(), { type: 'thinking-delta', text: 'hmm' }, end()]));
    const r = assessQuality(m, thresholds);
    expect(r.passed).toBe(false);
    expect(r.failures.join(' ')).toContain('unsettled');
  });

  it('fails on token overrun and error events', () => {
    const m = metricsFromTrace(
      rec([start(), turnStart(), usage(200_000, 0), { type: 'error', message: 'api down' }, end()]),
    );
    const r = assessQuality(m, thresholds);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.includes('tokens'))).toBe(true);
    expect(r.failures.some((f) => f.includes('error'))).toBe(true);
  });

  it('per-task budget override lowers maxTurns', () => {
    const m = metricsFromTrace(rec([start(), turnStart(), { type: 'turn-start', turn: 2 }, done(), end()]));
    const r = assessQuality(m, { ...thresholds, maxTurns: 1 });
    expect(r.passed).toBe(false);
    expect(r.failures.join(' ')).toContain('turns');
  });
});
