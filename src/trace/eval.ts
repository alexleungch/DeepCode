import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceRecord } from './types.js';
import { metricsFromTrace } from './metrics.js';
import { assessQuality, thresholdsFrom, type QualityReport, type QualityThresholdSource } from './quality.js';

/**
 * Eval runner (docs/PROMPT_SYSTEM.md §5): runs a task suite against the engine, records a trace
 * per attempt, scores it against the quality gates, and retries failures with a self-feedback
 * hint appended to the prompt — bounded by maxRetriesOnFail. Every attempt's trace is persisted,
 * so a regression is always replayable offline.
 *
 * `runTask` is injected (dependency injection), so the retry/feedback/quality logic is fully
 * unit-testable without a real provider or API key. The CLI wires it to a fresh engine per
 * attempt (src/cli/eval.ts).
 */

export interface EvalTask {
  id: string;
  prompt: string;
  /** Per-task budget overrides (merged over the global thresholds) */
  budget?: { maxTurns?: number; maxTokens?: number };
}

export interface EvalAttempt {
  attempt: number;
  trace: TraceRecord;
  metrics: ReturnType<typeof metricsFromTrace>;
  report: QualityReport;
  /** The feedback hint that was injected into this attempt's prompt (undefined for attempt 0) */
  feedback?: string;
}

export interface EvalTaskResult {
  task: EvalTask;
  attempts: EvalAttempt[];
  passed: boolean;
  finalScore: number;
  /** Score of the stored baseline report, when a baseline dir was provided */
  baselineScore?: number;
  /** Score dropped more than REGRESSION_TOLERANCE below the baseline */
  regressed?: boolean;
}

export interface EvalRunOptions {
  tasks: EvalTask[];
  /** Run a single attempt and return its trace (attach a TraceRecorder to the engine inside) */
  runTask: (task: EvalTask, attempt: number, feedback: string | undefined) => Promise<TraceRecord>;
  thresholds?: QualityThresholdSource;
  /** Self-feedback retry budget (default: config default 2) */
  maxRetriesOnFail?: number;
  /** Optional persistence hook: called after every attempt with its trace and report */
  persistAttempt?: (taskId: string, attempt: EvalAttempt) => void;
  /** Optional baseline dir: reads <baselineDir>/<taskId>.json {score} and flags regressions */
  baselineDir?: string;
}

export interface EvalRunReport {
  results: EvalTaskResult[];
  passed: number;
  failed: number;
  /** Mean final score across tasks (0-100) */
  score: number;
}

/** A new score is a regression if it drops more than this many points below the baseline */
const REGRESSION_TOLERANCE = 10;

export async function runEval(opts: EvalRunOptions): Promise<EvalRunReport> {
  const base = opts.thresholds
    ? thresholdsFrom(opts.thresholds)
    : {
        minToolSuccessRate: 0.8,
        maxTurns: 30,
        maxTokensPerTask: 150_000,
        requireSettled: true,
      };
  const maxRetries = opts.maxRetriesOnFail ?? 2;

  const results: EvalTaskResult[] = [];
  for (const task of opts.tasks) {
    const thresholds = {
      ...base,
      ...(task.budget?.maxTurns !== undefined ? { maxTurns: task.budget.maxTurns } : {}),
      ...(task.budget?.maxTokens !== undefined ? { maxTokensPerTask: task.budget.maxTokens } : {}),
    };

    const attempts: EvalAttempt[] = [];
    let feedback: string | undefined;
    let passed = false;
    let finalScore = 0;

    for (let attempt = 0; attempt <= maxRetries && !passed; attempt++) {
      const trace = await opts.runTask(task, attempt, feedback);
      const metrics = metricsFromTrace(trace);
      const report = assessQuality(metrics, thresholds);
      const entry: EvalAttempt = { attempt, trace, metrics, report, feedback };
      attempts.push(entry);
      opts.persistAttempt?.(task.id, entry);

      if (report.passed) {
        passed = true;
        finalScore = report.score;
        break;
      }
      finalScore = report.score;
      if (attempt < maxRetries) {
        feedback = `[Auto-feedback from previous attempt ${attempt + 1}] The quality gate failed: ${report.failures.join('; ')}. Fix these specific issues and retry. Do not repeat the same approach.`;
      }
    }

    let baselineScore: number | undefined;
    let regressed: boolean | undefined;
    if (opts.baselineDir) {
      const file = join(opts.baselineDir, `${task.id}.json`);
      if (existsSync(file)) {
        try {
          baselineScore = (JSON.parse(readFileSync(file, 'utf8')) as { score: number }).score;
          regressed = finalScore < baselineScore - REGRESSION_TOLERANCE;
        } catch {
          // unreadable baseline → no regression flag
        }
      }
    }

    results.push({ task, attempts, passed, finalScore, baselineScore, regressed });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    score: results.length === 0 ? 0 : Math.round(results.reduce((s, r) => s + r.finalScore, 0) / results.length),
  };
}

/** Load tasks from a directory of <id>.json files (malformed files are skipped) */
export function loadTasksFromDir(dir: string): EvalTask[] {
  if (!existsSync(dir)) return [];
  const tasks: EvalTask[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as EvalTask;
      if (parsed.id && typeof parsed.prompt === 'string') tasks.push(parsed);
    } catch {
      // skip malformed task files
    }
  }
  return tasks;
}

export function writeReportFile(dir: string, taskId: string, report: EvalRunReport): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.json`), JSON.stringify(report, null, 2), 'utf8');
}

export function writeBaseline(dir: string, taskId: string, score: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.json`), JSON.stringify({ score, updatedAt: Date.now() }, null, 2), 'utf8');
}
