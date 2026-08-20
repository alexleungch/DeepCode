import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import type { EngineEvent } from '../src/events.js';

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const DONE = 'data: [DONE]\n\n';

function streamChunk(delta: Record<string, unknown>, finish_reason: string | null = null): string {
  return sse({ id: 'fake-1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason }] });
}
function usageChunk(usage: Record<string, number>): string {
  return sse({ id: 'fake-1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-chat', choices: [], usage });
}
function streamToolCalls(calls: { id: string; name: string; args: Record<string, unknown> }[]): string {
  let out = '';
  for (const c of calls) {
    out += streamChunk({ tool_calls: [{ index: calls.indexOf(c), id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
    out += streamChunk({ tool_calls: [{ index: calls.indexOf(c), function: { arguments: JSON.stringify(c.args) } }] });
  }
  out += streamChunk({}, 'tool_calls');
  out += usageChunk({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  out += DONE;
  return out;
}

let server: Server;
let baseUrl = '';
let home: string;
let workspace: string;
let prevHome: string | undefined;
let events: EngineEvent[] = [];
let script: (body: { messages: { role: string; content?: unknown }[] }, idx: number) => string;
let reqCount = 0;

beforeAll(() => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const idx = (server as unknown as { __idx: number }).__idx ?? 0;
      (server as unknown as { __idx: number }).__idx = idx + 1;
      reqCount++;
      const resp = script(body, idx);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(resp);
    });
  });
  return new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      (server as unknown as { __idx: number }).__idx = 0;
      resolve();
    });
  });
});
afterAll(() => server.close());

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'dc-ws-'));
  prevHome = process.env.DEEPCODE_HOME;
  process.env.DEEPCODE_HOME = home;
  writeFileSync(join(workspace, 'hello.txt'), 'Hello, world\n', 'utf8');
  events = [];
  reqCount = 0;
  (server as unknown as { __idx: number }).__idx = 0;
});
afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* */ }
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

async function makeEngine(maxTurns: number, handler: 'allow' | 'deny-all' = 'allow') {
  script = () => streamToolCalls([{ id: `c${reqCount}`, name: 'read_file', args: { path: 'hello.txt' } }]);
  const resolved = loadConfig({ workspace });
  resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
  resolved.config.permissions.mode = 'ask';
  resolved.config.agent.maxTurns = maxTurns;
  const engine = new DeepcodeEngine({
    resolved,
    approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: handler === 'deny-all' ? 'deny' : 'allow' })), aborted: false }),
  });
  engine.onEvent((e) => events.push(e));
  await engine.init();
  return engine;
}

/** Seed the engine's session with N prior user/assistant turns so the compressor has
 *  foldable user turns (a single runTurn itself only ever adds ONE user message). */
function seedSession(engine: DeepcodeEngine, n: number): void {
  for (let i = 0; i < n; i++) {
    engine.session.messages.push({ role: 'user', content: `prior question ${i}` });
    engine.session.messages.push({ role: 'assistant', content: `prior answer ${i}` });
  }
}

describe('maxTurns cap behavior', () => {
  it('emits the segment-cap informational notice when auto-compact is disabled and the model keeps calling tools past maxTurns; the loop continues until maxTotalTurns', async () => {
    // With autoCompact off, the segment boundary has no compaction to try → it falls straight
    // through to the delegation attempt. With subagents disabled it skips delegation too and
    // emits the informational notice, resets segmentTurns=0, and continues — only the hard
    // maxTotalTurns backstop can stop the loop in this scenario.
    script = () => streamToolCalls([{ id: `c${reqCount}`, name: 'read_file', args: { path: 'hello.txt' } }]);
    const resolved = loadConfig({ workspace });
    resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
    resolved.config.permissions.mode = 'ask';
    resolved.config.agent.maxTurns = 3;
    resolved.config.agent.maxTotalTurns = 10; // hard backstop — gives the loop a finite horizon
    resolved.config.context.autoCompact = false;
    resolved.config.subagents.enabled = false; // force the fallback path (no delegation)
    const engine = new DeepcodeEngine({
      resolved,
      approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
    });
    engine.onEvent((e) => events.push(e));
    await engine.init();
    const result = await engine.runTurn('loop forever');
    // The loop runs to the hard backstop (10), not the segment cap (3), because segmentTurns
    // is reset on each cap-trip in the fallback path.
    expect(result.turns).toBe(10);
    expect(reqCount).toBe(10);
    expect(result.stopReason).toBe('max-total-turns');
    expect(result.interrupted).toBe(false);
    // The segment-cap informational notice (autoCompact=false variant) was emitted at least once
    // and the hard-backstop notice at the end.
    const msgs = events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message);
    expect(msgs.some((m) => m.includes('within a segment') && m.includes('auto-compaction is disabled') && m.includes('Continuing'))).toBe(true);
    expect(msgs.some((m) => m.includes('hard total-turn limit'))).toBe(true);
    engine.close();
  });

  it('middle-fold compaction at the segment boundary keeps a single-prompt tool loop running past maxTurns', async () => {
    // A model that NEVER stops calling tools. The standard compressor can't fold a single
    // user prompt + tool rounds (turnStarts.length <= keepRecentTurns), but the middle-fold
    // fallback at the segment boundary DOES reduce the conversation, so the loop continues.
    // The hard maxTotalTurns backstop is what finally stops it.
    //
    // The middle-fold only saves tokens when the conversation has substantial tool-result
    // content (the summary truncates each entry to ~600 chars), so we seed a larger file.
    writeFileSync(join(workspace, 'hello.txt'), ('Hello, world line\n'.repeat(80)), 'utf8');
    script = () => streamToolCalls([{ id: `c${reqCount}`, name: 'read_file', args: { path: 'hello.txt' } }]);
    const resolved = loadConfig({ workspace });
    resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
    resolved.config.permissions.mode = 'ask';
    resolved.config.agent.maxTurns = 4; // segment cap (compaction will reset the counter)
    resolved.config.agent.maxTotalTurns = 10; // hard backstop
    const engine = new DeepcodeEngine({
      resolved,
      approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
    });
    engine.onEvent((e) => events.push(e));
    await engine.init();
    const result = await engine.runTurn('long tool loop');
    // The agent ran PAST maxTurns (4) via middle-fold compaction, all the way to maxTotalTurns (10).
    expect(result.turns).toBe(10);
    expect(reqCount).toBe(10);
    expect(result.stopReason).toBe('max-total-turns');
    // At least one compaction event fired (proving the segment boundary kept resetting the counter).
    expect(events.some((e) => e.type === 'compacted')).toBe(true);
    // No segment-cap error — only the hard-cap message.
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('within a segment'))).toBe(false);
    engine.close();
  });

  it('does NOT emit the max-turns notice when the task finishes normally under the cap', async () => {
    // A model that returns a final answer on the first turn must not be flagged as hitting the cap.
    script = () => {
      let out = '';
      out += streamChunk({ role: 'assistant', content: 'done' });
      out += streamChunk({}, 'stop');
      out += usageChunk({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 });
      out += DONE;
      return out;
    };
    const resolved = loadConfig({ workspace });
    resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
    resolved.config.permissions.mode = 'ask';
    resolved.config.agent.maxTurns = 3;
    const engine = new DeepcodeEngine({
      resolved,
      approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
    });
    engine.onEvent((e) => events.push(e));
    await engine.init();
    const result = await engine.runTurn('say hi');
    expect(result.stopReason).toBe('end_turn');
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('maxTurns'))).toBe(false);
    engine.close();
  });

  it('resets the turn counter via turn-based compaction: a long task runs far past maxTurns when compactEveryTurns folds history', async () => {
    // The model keeps calling tools (never ends on its own) for the first 6 requests, then answers.
    script = (body, idx) => {
      if (idx < 6) {
        return streamToolCalls([{ id: `c${idx}`, name: 'read_file', args: { path: 'hello.txt' } }]);
      }
      let out = '';
      out += streamChunk({ role: 'assistant', content: 'done after compaction resets' });
      out += streamChunk({}, 'stop');
      out += usageChunk({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 });
      out += DONE;
      return out;
    };
    const resolved = loadConfig({ workspace });
    resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
    resolved.config.permissions.mode = 'ask';
    resolved.config.agent.maxTurns = 3; // small segment cap
    resolved.config.agent.maxTotalTurns = 50;
    resolved.config.context.compactEveryTurns = 2; // force a compaction every 2 turns
    resolved.config.context.keepRecentTurns = 1; // so compaction can actually fold old turns
    const engine = new DeepcodeEngine({
      resolved,
      approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
    });
    engine.onEvent((e) => events.push(e));
    await engine.init();
    seedSession(engine, 5); // prior turns so compaction has history to fold
    const result = await engine.runTurn('long task');
    // The compaction resets the counter each time, so the task survives far past maxTurns=3.
    expect(result.turns).toBeGreaterThan(3);
    expect(result.stopReason).toBe('end_turn');
    // At least one compaction actually happened (that's what reset the counter).
    expect(events.some((e) => e.type === 'compacted' && (e as { plan: { removedTurns: number } }).plan.removedTurns > 0)).toBe(true);
    // No max-turns error: the task completed, so the cap never tripped.
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('maxTurns'))).toBe(false);
    engine.close();
  });

  it('trips the hard maxTotalTurns backstop when the model never finishes and compaction keeps resetting the segment counter', async () => {
    // The model NEVER stops calling tools. Compaction succeeds (keepRecentTurns=1), so the segment
    // counter keeps resetting and only the total-turn backstop can stop the loop.
    script = () => streamToolCalls([{ id: `c${reqCount}`, name: 'read_file', args: { path: 'hello.txt' } }]);
    const resolved = loadConfig({ workspace });
    resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
    resolved.config.permissions.mode = 'ask';
    resolved.config.agent.maxTurns = 3; // segment cap (never reached — compaction keeps resetting)
    resolved.config.agent.maxTotalTurns = 7; // hard backstop
    resolved.config.context.compactEveryTurns = 2;
    resolved.config.context.keepRecentTurns = 1; // so compaction removes old turns and resets the counter
    const engine = new DeepcodeEngine({
      resolved,
      approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
    });
    engine.onEvent((e) => events.push(e));
    await engine.init();
    seedSession(engine, 5); // prior turns so compaction has history to fold
    const result = await engine.runTurn('runaway loop');
    // The loop ran up to the TOTAL cap (7), not the per-segment cap (3).
    expect(result.turns).toBe(7);
    expect(reqCount).toBe(7);
    expect(result.stopReason).toBe('max-total-turns');
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('maxTotalTurns'))).toBe(true);
    engine.close();
  });
});
