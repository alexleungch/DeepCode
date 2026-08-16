import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionLine, SessionRecord } from './types.js';
import type { ChatMessage } from '../providers/types.js';
import type { TodoItem } from '../tools/native/todo.js';
import type { UsageEvent } from '../usage/extractor.js';
import type { CompactionPlan } from '../agent/compressor.js';
import type { ProviderId } from '../config/types.js';

/** Session persistence: JSONL append + atomic write */
export class SessionStore {
  constructor(private sessionsDir: string) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  private fileOf(id: string): string {
    return join(this.sessionsDir, `${id}.jsonl`);
  }

  create(opts: { workspace: string; provider: ProviderId; model: string; title: string }): SessionRecord {
    const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const record: SessionRecord = {
      id,
      createdAt: now,
      updatedAt: now,
      workspace: opts.workspace,
      provider: opts.provider,
      model: opts.model,
      title: opts.title,
      messages: [],
      todos: [],
      usage: [],
      compacted: [],
    };
    this.writeMeta(record);
    return record;
  }

  private writeMeta(record: SessionRecord): void {
    const line: SessionLine = {
      t: 'meta',
      id: record.id,
      createdAt: record.createdAt,
      workspace: record.workspace,
      provider: record.provider,
      model: record.model,
      title: record.title,
    };
    this.appendLine(record.id, line);
  }

  private appendLine(id: string, line: SessionLine): void {
    const file = this.fileOf(id);
    const tmp = `${file}.tmp`;
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(tmp, existing + JSON.stringify(line) + '\n', 'utf8');
    renameSync(tmp, file);
  }

  appendMessage(id: string, message: ChatMessage): void {
    this.appendLine(id, { t: 'message', role: message.role, content: message.content });
    this.touch(id);
  }

  appendUsage(id: string, event: UsageEvent): void {
    this.appendLine(id, { t: 'usage', event });
    this.touch(id);
  }

  appendTodo(id: string, items: TodoItem[]): void {
    this.appendLine(id, { t: 'todo', items });
    this.touch(id);
  }

  appendCompaction(id: string, plan: CompactionPlan): void {
    this.appendLine(id, { t: 'compacted', plan });
    this.touch(id);
  }

  private touch(id: string): void {
    // Lightweight updatedAt update: appending a meta line is expensive, so use the file mtime in load/list instead
    void id;
  }

  /** Replay JSONL to rebuild a session */
  load(id: string): SessionRecord | undefined {
    const file = this.fileOf(id);
    if (!existsSync(file)) return undefined;
    let record: SessionRecord | undefined;
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      let parsed: SessionLine;
      try {
        parsed = JSON.parse(line) as SessionLine;
      } catch {
        continue;
      }
      if (parsed.t === 'meta') {
        record = {
          id: parsed.id,
          createdAt: parsed.createdAt,
          updatedAt: parsed.createdAt,
          workspace: parsed.workspace,
          provider: parsed.provider,
          model: parsed.model,
          title: parsed.title,
          messages: [],
          todos: [],
          usage: [],
          compacted: [],
        };
      } else if (record) {
        if (parsed.t === 'message') record.messages.push({ role: parsed.role, content: parsed.content });
        else if (parsed.t === 'usage') record.usage.push(parsed.event);
        else if (parsed.t === 'todo') record.todos = parsed.items;
        else if (parsed.t === 'compacted') record.compacted.push(parsed.plan);
      }
    }
    if (!record) return undefined;
    const st = existsSync(file) ? statSync(file) : undefined;
    record.updatedAt = st?.mtimeMs ?? record.updatedAt;
    return record;
  }

  /** Recent sessions list (mtime descending) */
  list(): { id: string; title: string; updatedAt: number; messageCount: number }[] {
    const out: { id: string; title: string; updatedAt: number; messageCount: number }[] = [];
    for (const f of readdirSync(this.sessionsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      const rec = this.load(id);
      if (!rec) continue;
      out.push({
        id: rec.id,
        title: rec.title,
        updatedAt: rec.updatedAt,
        messageCount: rec.messages.length,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(id: string): void {
    rmSync(this.fileOf(id), { force: true });
  }
}
