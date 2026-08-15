import { Command } from 'commander';
import { loadConfig } from '../config/loader.js';
import { UsageStore } from '../usage/store.js';
import { formatTokens } from '../agent/token-budget.js';
import { aggregateCacheHitRate } from '../caching/metrics.js';

export function usageCommand(): Command {
  const cmd = new Command('usage');
  cmd.description('Historical usage report (tokens and cost)');
  cmd
    .command('report [sessionId]')
    .description('Summarize usage per session')
    .action((sessionId?: string) => {
      const { paths } = loadConfig();
      const store = new UsageStore(paths.usageDbPath, paths.logsDir);
      const summaries = store.summarize(sessionId ? { sessionId } : undefined);
      if (summaries.length === 0) {
        process.stdout.write('(no usage records yet; when SQLite is unavailable, see ~/.deepcode/logs/usage.jsonl)\n');
        return;
      }
      for (const s of summaries.slice(0, 20)) {
        process.stdout.write(`${s.sessionId}  ${s.requests} requests  tokens ${formatTokens(s.totalTokens)}  $${s.costUsd.toFixed(4)}\n`);
      }
      const all = store.query({ limit: 2000 });
      const hitRate = aggregateCacheHitRate(all);
      if (hitRate !== null) {
        process.stdout.write(`Cache hit rate (last ${all.length} entries): ${(hitRate * 100).toFixed(1)}%\n`);
      }
      store.close();
    });
  return cmd;
}
