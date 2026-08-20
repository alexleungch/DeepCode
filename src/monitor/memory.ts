import { memoryUsage } from 'node:process';
import { getHeapStatistics } from 'node:v8';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime memory watchdog for long-lived processes (TUI sessions, `deepcode telegram` daemon).
 *
 * Why: heap OOM is a fatal V8 abort that no JS handler can catch, so the only way to see a leak
 * coming is to sample memory continuously and log it. The watchdog:
 *   - records a baseline at startup and one line per interval into <logDir>/memory.log
 *   - prints a console warning the first time heap usage exceeds `warnHeapRatio` of the heap
 *     limit (or RSS exceeds `warnRssMb`) — the process is at risk of an OOM abort
 *   - re-arms the warning when memory falls back below the threshold, so a leak that
 *     grows slowly still gets flagged
 * The interval timer is unref'd so it never keeps the process alive on its own.
 */

export interface MemorySample {
  ts: number;
  rssMb: number;
  heapUsedMb: number;
  heapLimitMb: number;
  heapRatio: number;
  externalMb: number;
  arrayBuffersMb: number;
}

export interface MemoryWatchdogOptions {
  /** Sampling interval in ms (default 60_000) */
  intervalMs?: number;
  /** Warn when heapUsed/heapLimit exceeds this (default 0.8) */
  warnHeapRatio?: number;
  /** Warn when RSS exceeds this many MB (default 2048 = 2 GB) */
  warnRssMb?: number;
  /** Directory for memory.log; sampling still runs (and warns) when omitted */
  logDir?: string;
  /** Optional sink for every sample (tests / custom logging) */
  onSample?: (s: MemorySample) => void;
}

export function sampleMemory(): MemorySample {
  const mem = memoryUsage();
  const heap = getHeapStatistics();
  const heapLimitMb = heap.heap_size_limit / 1024 / 1024;
  const heapUsedMb = mem.heapUsed / 1024 / 1024;
  return {
    ts: Date.now(),
    rssMb: mem.rss / 1024 / 1024,
    heapUsedMb,
    heapLimitMb,
    heapRatio: heapLimitMb > 0 ? heapUsedMb / heapLimitMb : 0,
    externalMb: mem.external / 1024 / 1024,
    arrayBuffersMb: mem.arrayBuffers / 1024 / 1024,
  };
}

function formatLine(s: MemorySample, kind: 'info' | 'warn'): string {
  return (
    `${new Date(s.ts).toISOString()} ${kind} ` +
    `rss=${s.rssMb.toFixed(1)}MB heap=${s.heapUsedMb.toFixed(1)}/${s.heapLimitMb.toFixed(0)}MB ` +
    `ratio=${(s.heapRatio * 100).toFixed(1)}% external=${s.externalMb.toFixed(1)}MB ` +
    `arrayBuffers=${s.arrayBuffersMb.toFixed(1)}MB`
  );
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

/** Start sampling memory; returns a stop() function. Timer is unref'd (does not block exit).
 *  Options default to env overrides DEEPCODE_MEMORY_INTERVAL_MS / DEEPCODE_MEMORY_WARN_HEAP_RATIO /
 *  DEEPCODE_MEMORY_WARN_RSS_MB when not passed explicitly. */
export function startMemoryWatchdog(opts: MemoryWatchdogOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? envInt('DEEPCODE_MEMORY_INTERVAL_MS', 60_000);
  const warnHeapRatio = opts.warnHeapRatio ?? envFloat('DEEPCODE_MEMORY_WARN_HEAP_RATIO', 0.8);
  const warnRssMb = opts.warnRssMb ?? envInt('DEEPCODE_MEMORY_WARN_RSS_MB', 2048);
  let warned = false;

  const write = (s: MemorySample, kind: 'info' | 'warn') => {
    const line = formatLine(s, kind);
    if (opts.logDir) {
      try {
        mkdirSync(opts.logDir, { recursive: true });
        appendFileSync(join(opts.logDir, 'memory.log'), line + '\n', 'utf8');
      } catch {
        // logging must never crash the app
      }
    }
    if (kind === 'warn') console.warn(`[deepcode][memory] ${line}`);
    opts.onSample?.(s);
  };

  const tick = () => {
    const s = sampleMemory();
    const over = s.heapRatio >= warnHeapRatio || s.rssMb >= warnRssMb;
    if (over) {
      if (!warned) {
        warned = true;
        write(s, 'warn');
      }
    } else {
      warned = false;
    }
    if (opts.logDir) write(s, 'info');
  };

  // Baseline sample on startup.
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
