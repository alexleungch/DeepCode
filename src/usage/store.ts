import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { UsageEvent } from './extractor.js';

/**
 * Usage persistence: SQLite (node:sqlite) + JSONL dual-write.
 * Automatically degrades to JSONL-only when SQLite is unavailable (Node < 22.5 or experimental API errors).
 */
export class UsageStore {
  private db: import('node:sqlite').DatabaseSync | null = null;
  private jsonlFile: string;
  private sqliteOk = true;

  constructor(dbPath: string, logsDir: string) {
    this.jsonlFile = join(logsDir, 'usage.jsonl');
    mkdirSync(logsDir, { recursive: true });
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage_events (
          ts INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          request_id TEXT,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          prompt_cache_hit_tokens INTEGER,
          prompt_cache_miss_tokens INTEGER,
          cached_content_token_count INTEGER,
          cost_usd REAL NOT NULL,
          latency_ms INTEGER NOT NULL,
          partial INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model, ts);
      `);
    } catch (e) {
      this.sqliteOk = false;
      this.db = null;
      console.warn(`[deepcode] SQLite unavailable, usage will only be written to JSONL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  append(event: UsageEvent): void {
    if (this.db && this.sqliteOk) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO usage_events (ts, session_id, provider, model, request_id, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens,
            cached_content_token_count, cost_usd, latency_ms, partial)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          event.ts,
          event.sessionId,
          event.provider,
          event.model,
          event.requestId ?? null,
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens ?? null,
          event.cacheWriteTokens ?? null,
          event.promptCacheHitTokens ?? null,
          event.promptCacheMissTokens ?? null,
          event.cachedContentTokenCount ?? null,
          event.costUsd,
          event.latencyMs,
          event.partial ? 1 : 0,
        );
      } catch {
        // A single write failure must not affect the main flow; fall back to JSONL
      }
    }
    try {
      appendFileSync(this.jsonlFile, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      // Ignore log write failures
    }
  }

  /** Query history (time descending); queries all when sessionId is omitted */
  query(opts?: { sessionId?: string; limit?: number }): UsageEvent[] {
    const rows: UsageEvent[] = [];
    if (this.db && this.sqliteOk) {
      try {
        const sql = opts?.sessionId
          ? 'SELECT * FROM usage_events WHERE session_id = ? ORDER BY ts DESC LIMIT ?'
          : 'SELECT * FROM usage_events ORDER BY ts DESC LIMIT ?';
        const stmt = this.db.prepare(sql);
        const results = stmt.all(opts?.sessionId ?? null, opts?.limit ?? 500) as Record<string, unknown>[];
        for (const r of results) {
          rows.push(rowToEvent(r));
        }
      } catch {
        // Return empty on query failure
      }
    }
    return rows;
  }

  /** Aggregate statistics per session (returns an empty array when SQLite is unavailable) */
  summarize(opts?: { sessionId?: string }): { sessionId: string; requests: number; totalTokens: number; costUsd: number }[] {
    if (!this.db || !this.sqliteOk) return [];
    try {
      const where = opts?.sessionId ? 'WHERE session_id = ?' : '';
      const sql = `SELECT session_id, COUNT(*) as requests, SUM(input_tokens + output_tokens) as totalTokens, SUM(cost_usd) as costUsd
        FROM usage_events ${where} GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT 100`;
      const stmt = this.db.prepare(sql);
      const results = stmt.all(...(opts?.sessionId ? [opts.sessionId] : [])) as {
        session_id: string;
        requests: number;
        totalTokens: number;
        costUsd: number;
      }[];
      return results.map((r) => ({ sessionId: r.session_id, requests: r.requests, totalTokens: r.totalTokens, costUsd: r.costUsd }));
    } catch {
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
  }
}

function rowToEvent(r: Record<string, unknown>): UsageEvent {
  return {
    ts: Number(r.ts),
    sessionId: String(r.session_id),
    provider: String(r.provider) as UsageEvent['provider'],
    model: String(r.model),
    requestId: r.request_id ? String(r.request_id) : undefined,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: r.cache_read_tokens == null ? undefined : Number(r.cache_read_tokens),
    cacheWriteTokens: r.cache_write_tokens == null ? undefined : Number(r.cache_write_tokens),
    promptCacheHitTokens: r.prompt_cache_hit_tokens == null ? undefined : Number(r.prompt_cache_hit_tokens),
    promptCacheMissTokens: r.prompt_cache_miss_tokens == null ? undefined : Number(r.prompt_cache_miss_tokens),
    cachedContentTokenCount: r.cached_content_token_count == null ? undefined : Number(r.cached_content_token_count),
    costUsd: Number(r.cost_usd),
    latencyMs: Number(r.latency_ms),
    partial: Number(r.partial) === 1,
  };
}
