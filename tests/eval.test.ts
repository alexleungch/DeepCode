import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '../src/events.js';
import type { TraceRecord } from '../src/trace/types.js';
import { runEval, loadTasksFromDir, type EvalTask } from '../src/trace/eval.js';

function rec(events: EngineEvent[]): TraceRecord {
  return {
    meta: { v: 1, sessionId: 't', provider: 'deepseek', model: 'm', workspace: '/w', startedAt: 0 },
    events: events.map((event, i) => ({ seq: i + 1, turn: 1, ts: i * 0.1, event })),
  };
}

/** A healthy trace: one turn, one successful tool, settled */
function goodTrace(): TraceRecord {
  return rec([
    { type: 'session-start', sessionId: 't', provider: 'deepseek', model: 'm', workspace: '/w', branch: null, resumed: false },
    { type: 'turn-start', turn: 1 },
    { type: 'usage', usage: { ts: 0, sessionId: 't', provider: 'deepseek', model: 'm', inputTokens: 500, outputTokens: 200, costUsd: 0.001, latencyMs: 100 } },
    { type: 'tool-start', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } },
    { type: 'tool-result', callId: 'c1', name: 'read_file', result: { content: 'ok' }, durationMs: 5 },
    { type: 'message', message: { role: 'assistant', content: 'done' }, source: 'assistant' },
    { type: 'session-end', sessionId: 't', reason: 'exit' },
  ]);
}

/** A trace that fails the quality gate: failed tool + unsettled streaming message */
function badTrace(): TraceRecord {
  return rec([
    { type: 'session-start', sessionId: 't', provider: 'deepseek', model: 'm', workspace: '/w', branch: null, resumed: false },
    { type: 'turn-start', turn: 1 },
    { type: 'tool-start', callId: 'c1', name: 'bash', input: { command: 'npm run lint' } },
    { type: 'tool-result', callId: 'c1', name: 'bash', result: { content: 'lint failed', isError: true }, durationMs: 5 },
    { type: 'thinking-delta', text: 'still going' },
    { type: 'session-end', sessionId: 't', reason: 'exit' },
  ]);
}

const tasks: EvalTask[] = [
  { id: 'always-good', prompt: 'fix the lint error' },
  { id: 'always-bad', prompt: 'fix the lint error' },
  { id: 'recovers', prompt: 'fix the lint error' },
];

describe('runEval', () => {
  it('passes a task on the first attempt when the trace is healthy', async () => {
    const calls: number[] = [];
    const report = await runEval({
      tasks: [tasks[0]!],
      runTask: async () => {
        calls.push(1);
        return goodTrace();
      },
    });
    expect(report.results[0]!.passed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('retries failing tasks with a feedback hint, bounded by maxRetriesOnFail', async () => {
    const prompts: string[] = [];
    const report = await runEval({
      tasks: [tasks[1]!],
      maxRetriesOnFail: 2,
      runTask: async (task, _attempt, feedback) => {
        prompts.push(task.prompt + (feedback ? `\n\n${feedback}` : ''));
        return badTrace();
      },
    });
    const r = report.results[0]!;
    expect(r.passed).toBe(false);
    expect(r.attempts).toHaveLength(3); // initial + 2 retries
    // every retry after the first carries a feedback hint referencing the failing checks
    expect(prompts[1]).toContain('[Auto-feedback');
    expect(prompts[1]).toContain('tool success rate');
    expect(prompts[2]).toContain('[Auto-feedback');
  });

  it('stops retrying as soon as a retry passes (self-feedback iteration works)', async () => {
    const report = await runEval({
      tasks: [tasks[2]!],
      maxRetriesOnFail: 3,
      runTask: async (task, attempt) => (attempt === 0 ? badTrace() : goodTrace()),
    });
    const r = report.results[0]!;
    expect(r.passed).toBe(true);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[1]!.feedback).toContain('[Auto-feedback');
    expect(r.attempts[1]!.report.passed).toBe(true);
  });

  it('applies per-task budget overrides to the thresholds', async () => {
    // 1 turn is fine for always-good (maxTurns 30) — force a low budget to make it fail
    const report = await runEval({
      tasks: [{ id: 'tight', prompt: 'x', budget: { maxTurns: 0 } }],
      runTask: async () => goodTrace(),
    });
    const r = report.results[0]!;
    expect(r.passed).toBe(false);
    expect(r.attempts[0]!.report.failures.join(' ')).toContain('turns');
  });

  it('flags a regression when the score drops below the stored baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-base-'));
    try {
      // baseline score 100 for always-good; the attempt below scores ~83 (tokens overrun + an error event)
      writeFileSync(join(dir, 'always-good.json'), JSON.stringify({ score: 100, updatedAt: 0 }));
      const t = { id: 'always-good', prompt: 'x' } as EvalTask;
      const report = await runEval({
        tasks: [t],
        baselineDir: dir,
        runTask: async () => rec([
          { type: 'session-start', sessionId: 't', provider: 'deepseek', model: 'm', workspace: '/w', branch: null, resumed: false },
          { type: 'turn-start', turn: 1 },
          { type: 'usage', usage: { ts: 0, sessionId: 't', provider: 'deepseek', model: 'm', inputTokens: 90_000, outputTokens: 90_000, costUsd: 0.1, latencyMs: 100 } },
          { type: 'tool-start', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool-result', callId: 'c1', name: 'read_file', result: { content: 'ok' }, durationMs: 5 },
          { type: 'message', message: { role: 'assistant', content: 'done' }, source: 'assistant' },
          { type: 'error', message: 'api timeout' },
          { type: 'session-end', sessionId: 't', reason: 'exit' },
        ]),
      });
      const r = report.results[0]!;
      expect(r.regressed).toBe(true);
      expect(r.baselineScore).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists every attempt via the persistAttempt hook', async () => {
    const seen: string[] = [];
    await runEval({
      tasks: [tasks[1]!],
      maxRetriesOnFail: 1,
      runTask: async () => badTrace(),
      persistAttempt: (taskId) => {
        seen.push(taskId);
      },
    });
    expect(seen).toEqual(['always-bad', 'always-bad']);
  });
});

describe('loadTasksFromDir', () => {
  it('loads <id>.json task files and skips malformed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-tasks-'));
    try {
      writeFileSync(join(dir, 'good.json'), JSON.stringify({ id: 'good', prompt: 'do it' }));
      writeFileSync(join(dir, 'bad.json'), '{not json');
      const tasks = loadTasksFromDir(dir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe('good');
      expect(existsSync(join(dir, 'good.json'))).toBe(true);
      expect(readFileSync(join(dir, 'good.json'), 'utf8')).toContain('do it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
