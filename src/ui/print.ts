import type { EngineEvent } from '../events.js';
import { formatTokens } from '../agent/token-budget.js';
import type { UsageTracker } from '../usage/extractor.js';

interface PrintRendererOptions {
  usage: UsageTracker;
  verbose?: boolean;
}

/**
 * --print headless renderer: renders the engine event stream as plain text to stdout.
 * Shares the same engine as the TUI; used for scripts, logs and integration tests (deterministic output).
 */
export function createPrintRenderer(opts: PrintRendererOptions) {
  let assistantText = '';
  let toolOutput = '';

  const onEvent = (event: EngineEvent) => {
    switch (event.type) {
      case 'session-start':
        process.stdout.write(`[deepcode] ${event.provider}/${event.model} · ${event.workspace}${event.resumed ? ' (resumed session)' : ''}\n`);
        break;
      case 'text-delta':
        process.stdout.write(event.text);
        assistantText += event.text;
        break;
      case 'thinking-delta':
        if (opts.verbose) process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
        break;
      case 'tool-start': {
        process.stdout.write(`\n⚙ ${event.name} ${JSON.stringify(event.input)}\n`);
        break;
      }
      case 'tool-progress':
        toolOutput += event.text;
        break;
      case 'tool-result': {
        const body = event.result.content.replace(/\n/g, '\n  ').slice(0, 2000);
        const err = event.result.isError ? ' ❌' : ' ✓';
        process.stdout.write(`  ↳ ${event.name}${err} (${event.durationMs}ms)\n  ${body}\n`);
        break;
      }
      case 'approval-request':
        if (process.stdin.isTTY) {
          process.stdout.write(`\n[approval] ${event.items.map((i) => i.description).join(' | ')}\n`);
        }
        break;
      case 'usage': {
        if (!event.usage.partial) {
          const u = event.usage;
          const cache = u.cacheReadTokens ? ` cache↗${formatTokens(u.cacheReadTokens)}` : '';
          process.stdout.write(`\n[usage] in=${formatTokens(u.inputTokens)} out=${formatTokens(u.outputTokens)}${cache} $${u.costUsd.toFixed(6)} (total $${opts.usage.totalsSnapshot().costUsd.toFixed(4)})\n`);
        }
        break;
      }
      case 'compacted':
        process.stdout.write(`\n[compact] compacted ${event.plan.removedTurns} turns: ${formatTokens(event.plan.tokensBefore)} → ${formatTokens(event.plan.tokensAfter)} (saved ${formatTokens(event.plan.savedTokens)})\n`);
        break;
      case 'memory-saved':
        process.stdout.write(`\n[memory] saved ${event.entries.length} memories\n`);
        break;
      case 'subagent-status':
        process.stdout.write(`\n[subagent] ${event.label}: ${event.status}\n`);
        break;
      case 'interrupted':
        process.stdout.write('\n[interrupted]\n');
        break;
      case 'error':
        process.stdout.write(`\n[error] ${event.message}\n`);
        break;
      case 'session-end':
        process.stdout.write('\n');
        break;
      default:
        break;
    }
  };

  return { onEvent };
}
