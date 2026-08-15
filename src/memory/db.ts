import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryType } from '../config/types.js';

export interface MemoryEntry {
  id: number;
  scope: 'global' | 'project';
  type: MemoryType;
  content: string;
  summary: string;
  importance: number;
  accessCount: number;
  lastAccess: number;
  createdAt: number;
  updatedAt: number;
  score?: number;
}

export interface SaveMemoryInput {
  scope?: 'global' | 'project';
  type: MemoryType;
  content: string;
  importance?: number;
  sessionId?: string;
}

/**
 * Fully local memory store (node:sqlite + FTS5 keyword search; JSONL fallback).
 * Follows TencentDB-Agent-Memory's local, zero-dependency principle.
 */
export class MemoryDb {
  private db: import('node:sqlite').DatabaseSync | null = null;
  private jsonlFile: string;
  private sqliteOk = true;

  constructor(dbPath: string, fallbackDir: string) {
    this.jsonlFile = join(fallbackDir, 'memory.jsonl');
    mkdirSync(fallbackDir, { recursive: true });
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL DEFAULT 'global',
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          importance REAL NOT NULL DEFAULT 0.5,
          access_count INTEGER NOT NULL DEFAULT 0,
          last_access INTEGER NOT NULL DEFAULT 0,
          session_id TEXT,
          created INTEGER NOT NULL,
          updated INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='id');
        CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, type);
        -- FTS sync triggers
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
    } catch (e) {
      this.sqliteOk = false;
      this.db = null;
      console.warn(`[deepcode] memory store: SQLite unavailable, falling back to JSONL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  save(input: SaveMemoryInput): MemoryEntry {
    const now = Date.now();
    const entry: MemoryEntry = {
      id: -1,
      scope: input.scope ?? 'global',
      type: input.type,
      content: input.content.slice(0, 20_000),
      summary: makeSummary(input.content),
      importance: clamp(input.importance ?? defaultImportance(input.type), 0, 1),
      accessCount: 0,
      lastAccess: now,
      createdAt: now,
      updatedAt: now,
    };
    if (this.db && this.sqliteOk) {
      try {
        const stmt = this.db.prepare(
          'INSERT INTO memories (scope, type, content, summary, importance, access_count, last_access, session_id, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
        );
        const r = stmt.run(entry.scope, entry.type, entry.content, entry.summary, entry.importance, now, input.sessionId ?? null, now, now);
        entry.id = Number(r.lastInsertRowid);
        return entry;
      } catch {
        // Fall back to JSONL
      }
    }
    entry.id = Date.now() % 1_000_000;
    try {
      appendFileSync(this.jsonlFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // ignore
    }
    return entry;
  }

  /**
   * Hybrid retrieval: FTS5 keyword hits (weighted) + SQL LIKE + importance/recency/access-frequency scoring.
   * Semantic retrieval is an optional plugin (stretch).
   */
  search(query: string, opts?: { limit?: number; scope?: 'global' | 'project' }): MemoryEntry[] {
    const limit = opts?.limit ?? 5;
    const entries: MemoryEntry[] = [];
    if (this.db && this.sqliteOk) {
      const like = `%${query}%`;
      const ftsTerms = ftsEscape(query);
      const scoreSql = `
            + m.importance * 0.5
            + 0.3 * exp(-(julianday('now') - julianday(m.last_access / 1000, 'unixepoch')) / 30)
            + 0.2 * min(m.access_count, 5) / 5`;
      const whereScope = '(? IS NULL OR m.scope = ?)';
      try {
        // Preferred: FTS5 hit weighting
        const sql = `
          SELECT m.*, CASE WHEN m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?) THEN 1.5 ELSE 0 END AS fts_hit
          FROM memories m
          WHERE ${whereScope}
            AND (m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?) OR m.content LIKE ? OR m.summary LIKE ?)
          ORDER BY ((CASE WHEN m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?) THEN 1.5 ELSE 0 END) ${scoreSql}) DESC
          LIMIT ?`;
        const rows = this.db
          .prepare(sql)
          .all(ftsTerms, opts?.scope ?? null, opts?.scope ?? null, ftsTerms, like, like, ftsTerms, limit) as Record<string, unknown>[];
        for (const r of rows) {
          entries.push(rowToEntry(r));
        }
      } catch {
        // FTS unavailable (syntax/special characters): fall back to LIKE
        try {
          const sql = `
            SELECT m.*, 0 AS fts_hit FROM memories m
            WHERE ${whereScope} AND (m.content LIKE ? OR m.summary LIKE ?)
            ORDER BY (${scoreSql}) DESC LIMIT ?`;
          const rows = this.db
            .prepare(sql)
            .all(opts?.scope ?? null, opts?.scope ?? null, like, like, limit) as Record<string, unknown>[];
          for (const r of rows) {
            entries.push(rowToEntry(r));
          }
        } catch {
          // Empty fallback
        }
      }
    }
    if (entries.length === 0) {
      // JSONL mode or SQLite failure: linear scan
      try {
        for (const line of readFileSync(this.jsonlFile, 'utf8').split('\n').filter(Boolean)) {
          const e = JSON.parse(line) as MemoryEntry;
          if (opts?.scope && e.scope !== opts.scope) continue;
          if (e.content.toLowerCase().includes(query.toLowerCase()) || e.summary.toLowerCase().includes(query.toLowerCase())) {
            e.score = e.importance;
            entries.push(e);
          }
        }
      } catch {
        // ignore
      }
    }
    return entries.slice(0, limit);
  }

  list(opts?: { type?: MemoryType; scope?: 'global' | 'project'; limit?: number }): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    if (this.db && this.sqliteOk) {
      try {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (opts?.type) {
          clauses.push('type = ?');
          params.push(opts.type);
        }
        if (opts?.scope) {
          clauses.push('scope = ?');
          params.push(opts.scope);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        params.push(opts?.limit ?? 50);
        const rows = this.db
          .prepare(`SELECT * FROM memories ${where} ORDER BY updated DESC LIMIT ?`)
          .all(...(params as (string | number | null)[])) as Record<string, unknown>[];
        for (const r of rows) out.push(rowToEntry(r));
      } catch {
        // ignore
      }
    } else {
      try {
        for (const line of readFileSync(this.jsonlFile, 'utf8').split('\n').filter(Boolean)) {
          const e = JSON.parse(line) as MemoryEntry;
          if (opts?.type && e.type !== opts.type) continue;
          if (opts?.scope && e.scope !== opts.scope) continue;
          out.push(e);
        }
      } catch {
        // ignore
      }
    }
    return out.slice(0, opts?.limit ?? 50);
  }

  touch(id: number): void {
    if (!this.db || !this.sqliteOk) return;
    try {
      this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_access = ? WHERE id = ?').run(Date.now(), id);
    } catch {
      // ignore
    }
  }

  remove(id: number): boolean {
    if (this.db && this.sqliteOk) {
      try {
        const r = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
        return Number(r.changes) > 0;
      } catch {
        return false;
      }
    }
    return false;
  }

  count(): number {
    if (!this.db || !this.sqliteOk) return 0;
    try {
      const r = this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
      return Number(r.c);
    } catch {
      return 0;
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

function rowToEntry(r: Record<string, unknown>): MemoryEntry {
  return {
    id: Number(r.id),
    scope: String(r.scope) as MemoryEntry['scope'],
    type: String(r.type) as MemoryType,
    content: String(r.content),
    summary: String(r.summary),
    importance: Number(r.importance),
    accessCount: Number(r.access_count),
    lastAccess: Number(r.last_access),
    createdAt: Number(r.created),
    updatedAt: Number(r.updated),
    score: 'fts_hit' in r ? (Number(r.fts_hit) ? 1.5 + Number(r.importance) * 0.5 : Number(r.importance) * 0.5) : Number(r.importance),
  };
}

function ftsEscape(query: string): string {
  return query
    .replace(/["':，。！？、；()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => `"${t}"`)
    .join(' OR ');
}

function makeSummary(content: string): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= 120) return clean;
  return clean.slice(0, 120) + '…';
}

function defaultImportance(type: MemoryType): number {
  switch (type) {
    case 'preference':
      return 0.8;
    case 'fact':
      return 0.6;
    case 'experience':
      return 0.5;
    case 'episode':
      return 0.4;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
