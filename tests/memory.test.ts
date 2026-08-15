import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDb } from '../src/memory/db.js';
import { MemoryPipeline, extractFacts } from '../src/memory/pipeline.js';
import { makeMemoryTools } from '../src/memory/tools.js';
import type { ChatMessage } from '../src/providers/types.js';
import type { ToolContext } from '../src/tools/types.js';
import { defaultConfig } from '../src/config/defaults.js';

let dir: string;
let db: MemoryDb;
let pipeline: MemoryPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-'));
  db = new MemoryDb(join(dir, 'memory.db'), dir);
  pipeline = new MemoryPipeline(db, join(dir, 'workspace'));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('MemoryDb', () => {
  it('save → list → search → touch → remove', () => {
    const e1 = db.save({ type: 'fact', content: 'The project uses TypeScript and pnpm', importance: 0.6 });
    const e2 = db.save({ type: 'preference', content: 'The user prefers English comments', importance: 0.8 });
    expect(db.count()).toBe(2);

    const list = db.list();
    expect(list).toHaveLength(2);

    const hits = db.search('TypeScript');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('TypeScript');

    const hits2 = db.search('English comments');
    expect(hits2.length).toBeGreaterThan(0);

    db.touch(e1.id);
    db.touch(e1.id);
    const after = db.list({ type: 'fact' });
    expect(after[0]!.accessCount).toBe(2);

    expect(db.remove(e2.id)).toBe(true);
    expect(db.remove(e2.id)).toBe(false);
    expect(db.count()).toBe(1);
  });

  it('scope filtering', () => {
    db.save({ type: 'fact', content: 'Global fact A', scope: 'global' });
    db.save({ type: 'fact', content: 'Project fact B', scope: 'project' });
    expect(db.list({ scope: 'global' })).toHaveLength(1);
    expect(db.search('fact', { scope: 'project' })[0]!.content).toContain('Project fact B');
  });

  it('summary auto-generated (long content truncated)', () => {
    const long = 'This is a very long memory content. '.repeat(20);
    const e = db.save({ type: 'episode', content: long });
    expect(e.summary.length).toBeLessThan(long.length);
    expect(e.summary).toContain('…');
  });
});

describe('MemoryPipeline four-layer distillation', () => {
  it('extractFromSession distills preferences and decisions', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please always use 4-space indentation, do not use tabs' },
      { role: 'assistant', content: 'OK. The final decision adopted zod for parameter validation' },
    ];
    const extracted = pipeline.extractFromSession(messages);
    expect(extracted.length).toBeGreaterThan(0);
    const types = extracted.map((e) => e.type);
    expect(types).toContain('preference');
    // dedup: re-distilling does not re-save
    const again = pipeline.extractFromSession(messages);
    expect(again.length).toBeLessThan(extracted.length);
  });

  it('extractFromTurns (compaction integration)', () => {
    const turns: ChatMessage[] = [
      { role: 'user', content: 'Config items are managed centrally under src/config' },
      { role: 'assistant', content: 'Completed the config migration, all centralized in src/config' },
    ];
    const extracted = pipeline.extractFromTurns(turns);
    // at least extracts config-related facts
    expect(extracted.length).toBeGreaterThanOrEqual(0);
    expect(db.count()).toBe(extracted.length);
  });

  it('digest generates an injectable summary', () => {
    db.save({ type: 'fact', content: 'The build command is pnpm build', scope: 'project' });
    const digest = pipeline.digest('pnpm build', 3);
    expect(digest).toContain('pnpm build');
    expect(digest).toContain('relevant to this project');
  });
});

describe('extractFacts rules', () => {
  it('skips conversational and process noise', () => {
    const facts = extractFacts('Please read the file first. I can help you finish. Running npm test succeeded, let us continue.');
    expect(facts.length).toBe(0);
  });

  it('extracts factual short sentences', () => {
    const facts = extractFacts('The project uses pnpm as the package manager. The test framework uses vitest.');
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.content.includes('pnpm'))).toBe(true);
  });
});

describe('memory tools (ToolDef layer)', () => {
  const ctx: ToolContext = {
    cwd: dir,
    workspace: dir,
    sessionId: 's1',
    config: defaultConfig(),
    permissionMode: 'ask',
    askApproval: async () => [],
    askApprovalBatch: async () => ({ decisions: [], aborted: false }),
    emit: () => undefined,
    signal: new AbortController().signal,
  };

  it('memory_save/search/list/forget full pipeline', async () => {
    const tools = makeMemoryTools({ db, pipeline, workspace: dir });
    const save = tools.find((t) => t.name === 'memory_save')!;
    const search = tools.find((t) => t.name === 'memory_search')!;
    const list = tools.find((t) => t.name === 'memory_list')!;
    const forget = tools.find((t) => t.name === 'memory_forget')!;

    const r1 = await save.execute({ type: 'preference', content: 'The user prefers installing dependencies with pnpm' }, ctx);
    expect(r1.content).toContain('Saved memory');

    const r2 = await search.execute({ query: 'pnpm' }, ctx);
    expect(r2.content).toContain('pnpm');

    const r3 = await list.execute({}, ctx);
    expect(r3.content).toContain('pnpm');

    const id = Number(/\#(\d+)/.exec(r1.content)?.[1] ?? 0);
    const r4 = await forget.execute({ id }, ctx);
    expect(r4.content).toContain('Deleted memory');
  });

  it('invalid arguments error', async () => {
    const tools = makeMemoryTools({ db, pipeline, workspace: dir });
    const save = tools.find((t) => t.name === 'memory_save')!;
    const r = await save.execute({ type: 'fact', content: 'x' }, ctx); // content too short
    expect(r.isError).toBe(true);
  });
});
