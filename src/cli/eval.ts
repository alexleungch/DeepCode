import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { DeepcodeEngine } from '../engine.js';
import { TraceRecorder } from '../trace/recorder.js';
import { loadTrace } from '../trace/replay.js';
import { loadTasksFromDir, runEval, writeBaseline, type EvalAttempt, type EvalTask } from '../trace/eval.js';

function writeJson(dir: string, name: string, obj: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * `deepcode eval` — headless eval runner (docs/PROMPT_SYSTEM.md §5).
 * Each attempt gets a fresh engine + TraceRecorder, so every run is replayable offline.
 */
export function evalCommand(): Command {
  const cmd = new Command('eval');
  cmd
    .description('Run the eval task suite: trace recording + quality gates + self-feedback retries (docs/PROMPT_SYSTEM.md §5)')
    .argument('[tasksDir]', 'Directory of <id>.json tasks (default: <data dir>/traces/tasks)')
    .option('--corpus <dir>', 'Directory to persist attempt traces and reports (default: <data dir>/traces/corpus)')
    .option('--baseline <dir>', 'Baseline scores dir for regression comparison (default: <data dir>/traces/baseline)')
    .option('--no-baseline', 'Do not read/write baselines')
    .option('--max-retries <n>', 'Self-feedback retry budget per task', '2')
    .action(async (tasksDirArg: string | undefined, opts: Record<string, unknown>) => {
      const resolved = loadConfig();
      const dataDir = dirname(resolved.paths.sessionsDir);
      const tasksDir = tasksDirArg ?? join(dataDir, 'traces', 'tasks');
      const corpusDir = (opts.corpus as string | undefined) ?? join(dataDir, 'traces', 'corpus');
      const useBaseline = opts.baseline !== false;
      const baselineDir = opts.baseline === true || typeof opts.baseline !== 'string'
        ? join(dataDir, 'traces', 'baseline')
        : (opts.baseline as string);
      const maxRetries = Number(opts.maxRetries ?? 2);

      const tasks = loadTasksFromDir(tasksDir);
      if (tasks.length === 0) {
        console.error(`No eval tasks found in ${tasksDir} (expected <id>.json files with {id, prompt})`);
        process.exit(1);
      }

      const { quality } = resolved.config.prompt;
      const report = await runEval({
        tasks,
        thresholds: quality,
        maxRetriesOnFail: maxRetries,
        baselineDir: useBaseline ? baselineDir : undefined,
        runTask: async (task: EvalTask, attempt: number, feedback: string | undefined) => {
          const engine = new DeepcodeEngine({
            resolved,
            permissionMode: 'bypassPermissions',
            title: `${task.id}#${attempt}`,
          });
          const rec = new TraceRecorder(corpusDir, `${task.id}-a${attempt}`);
          engine.onEvent(rec.onEvent);
          await engine.init();
          try {
            const prompt = feedback ? `${task.prompt}\n\n${feedback}` : task.prompt;
            await engine.runTurn(prompt);
          } finally {
            engine.close();
          }
          return loadTrace(rec.file);
        },
        persistAttempt: (taskId: string, entry: EvalAttempt) => {
          const { report: r } = entry;
          writeJson(corpusDir, `${taskId}-a${entry.attempt}.report.json`, {
            attempt: entry.attempt,
            score: r.score,
            passed: r.passed,
            failures: r.failures,
            metrics: entry.metrics,
            feedback: entry.feedback,
          });
        },
      });

      // Summary
      console.log(`\neval summary: ${report.passed}/${report.results.length} passed, mean score ${report.score}/100\n`);
      for (const r of report.results) {
        const first = r.attempts[0]!;
        const flag = r.passed ? 'PASS' : 'FAIL';
        const reg = r.regressed === true ? '  [REGRESSION vs baseline]' : '';
        console.log(
          `  ${flag}  ${r.task.id.padEnd(24)} score=${String(r.finalScore).padStart(3)}  attempts=${r.attempts.length}  turns=${first.metrics.turns}  tools=${first.metrics.toolCalls}  tokens=${first.metrics.tokensIn + first.metrics.tokensOut}${reg}`,
        );
        if (!r.passed) {
          for (const a of r.attempts) {
            if (a.report.failures.length > 0) {
              console.log(`        attempt ${a.attempt}: ${a.report.failures.join('; ')}`);
            }
          }
        }
      }

      // Persist per-task results + fresh baselines for passing tasks
      for (const r of report.results) {
        writeJson(corpusDir, `${r.task.id}.result.json`, {
          task: r.task,
          passed: r.passed,
          score: r.finalScore,
          baselineScore: r.baselineScore,
          regressed: r.regressed,
          attempts: r.attempts.map((a) => ({
            attempt: a.attempt,
            score: a.report.score,
            passed: a.report.passed,
            failures: a.report.failures,
            trace: `${r.task.id}-a${a.attempt}.trace.jsonl`,
            feedback: a.feedback,
          })),
        });
        if (r.passed && useBaseline) writeBaseline(baselineDir, r.task.id, r.finalScore);
      }
      writeJson(corpusDir, 'summary.json', { score: report.score, passed: report.passed, failed: report.failed, results: report.results.length });

      if (report.failed > 0) process.exitCode = 1;
    });
  return cmd;
}
