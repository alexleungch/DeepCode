import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { parseSkillFile, SkillLoader } from '../src/skills/loader.js';

describe('SessionStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('create -> append -> replay', () => {
    const store = new SessionStore(dir);
    const rec = store.create({ workspace: 'W', provider: 'deepseek', model: 'deepseek-chat', title: 't' });
    store.appendMessage(rec.id, { role: 'user', content: 'hello' });
    store.appendMessage(rec.id, { role: 'assistant', content: 'hi' });
    store.appendUsage(rec.id, {
      ts: Date.now(), sessionId: rec.id, provider: 'deepseek', model: 'deepseek-chat',
      inputTokens: 10, outputTokens: 5, costUsd: 0.001, latencyMs: 100,
    });
    const loaded = store.load(rec.id);
    expect(loaded).toBeDefined();
    expect(loaded!.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(loaded!.usage).toHaveLength(1);
    expect(store.list()[0]!.id).toBe(rec.id);
  });

  it('load returns undefined for a missing session', () => {
    const store = new SessionStore(dir);
    expect(store.load('nope')).toBeUndefined();
  });

  it('remove deletes the file', () => {
    const store = new SessionStore(dir);
    const rec = store.create({ workspace: 'W', provider: 'ollama', model: 'qwen3:32b', title: 't' });
    store.remove(rec.id);
    expect(store.load(rec.id)).toBeUndefined();
  });

  it('todos persist', () => {
    const store = new SessionStore(dir);
    const rec = store.create({ workspace: 'W', provider: 'ollama', model: 'qwen3:32b', title: 't' });
    store.appendTodo(rec.id, [{ content: 'a', status: 'in_progress' }]);
    expect(store.load(rec.id)!.todos).toEqual([{ content: 'a', status: 'in_progress' }]);
  });
});

describe('SkillLoader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    mkdirSync(join(dir, 'code-review'));
    writeFileSync(
      join(dir, 'code-review', 'SKILL.md'),
      `---
name: code-review
description: code review skill
---

# Code review
Line-by-line review…`,
    );
    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'bad', 'SKILL.md'), 'no frontmatter');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parseSkillFile parses frontmatter and body', () => {
    const parsed = parseSkillFile(join(dir, 'code-review', 'SKILL.md'));
    expect(parsed?.name).toBe('code-review');
    expect(parsed?.description).toBe('code review skill');
    expect(parsed?.body).toContain('# Code review');
  });

  it('loadAll only loads valid skills', async () => {
    const loader = new SkillLoader(dir, { enabled: true, directories: [] });
    const skills = await loader.loadAll();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('code-review');
    expect(skills[0]!.scope).toBe('user');
    expect(skills[0]!.sizeTokens).toBeGreaterThan(0);
  });

  it('project-level overrides a same-named user skill', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'proj-'));
    mkdirSync(join(projectDir, 'skills', 'code-review'), { recursive: true });
    writeFileSync(
      join(projectDir, 'skills', 'code-review', 'SKILL.md'),
      `---
name: code-review
description: project-specific version
---
project version`,
    );
    const loader = new SkillLoader(dir, { enabled: true, directories: [] });
    const skills = await loader.loadAll(projectDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.scope).toBe('project');
    expect(skills[0]!.description).toBe('project-specific version');
    rmSync(projectDir, { recursive: true, force: true });
  });
});

describe('UsageStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('append then summarize (when SQLite is available)', async () => {
    let DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
    try {
      const mod = (await import('node:sqlite')) as { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } };
      DatabaseSync = mod.DatabaseSync;
      void DatabaseSync;
    } catch {
      return; // skip SQLite assertions on Node < 22.5
    }
    const { UsageStore } = await import('../src/usage/store.js');
    const store = new UsageStore(join(dir, 'usage.db'), dir);
    store.append({
      ts: Date.now(), sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat',
      inputTokens: 100, outputTokens: 20, costUsd: 0.0001, latencyMs: 50,
    });
    const sum = store.summarize({ sessionId: 's1' });
    expect(sum).toHaveLength(1);
    expect(sum[0]!.requests).toBe(1);
    expect(sum[0]!.totalTokens).toBe(120);
    const rows = store.query({ sessionId: 's1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('deepseek-chat');
    // JSONL double-write
    const jsonl = readFileSync(join(dir, 'usage.jsonl'), 'utf8');
    expect(jsonl).toContain('"sessionId":"s1"');
    store.close();
  });
});
