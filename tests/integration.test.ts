import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import type { ApprovalResult } from '../src/tools/permission.js';
import type { EngineEvent } from '../src/events.js';

// ---------- fake provider: OpenAI-compatible SSE stream ----------

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function streamChunk(delta: Record<string, unknown>, finish_reason: string | null = null): string {
  return sse({
    id: 'fake-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason }],
  });
}

function usageChunk(usage: Record<string, number>): string {
  return sse({ id: 'fake-1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-chat', choices: [], usage });
}

/** Streaming tool_calls response */
function streamToolCalls(calls: { id: string; name: string; args: Record<string, unknown> }[], leadText = ''): string {
  let out = '';
  if (leadText) out += streamChunk({ role: 'assistant', content: leadText });
  for (const c of calls) {
    out += streamChunk({ tool_calls: [{ index: calls.indexOf(c), id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
    out += streamChunk({ tool_calls: [{ index: calls.indexOf(c), function: { arguments: JSON.stringify(c.args) } }] });
  }
  out += streamChunk({}, 'tool_calls');
  out += usageChunk({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  out += DONE;
  return out;
}

/** Streaming text response */
function streamText(text: string, usage?: Record<string, number>): string {
  let out = '';
  for (let i = 0; i < text.length; i += 7) {
    out += streamChunk({ content: text.slice(i, i + 7) });
  }
  out += streamChunk({}, 'stop');
  out += usageChunk(usage ?? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  out += DONE;
  return out;
}

// ---------- test infrastructure ----------

let server: Server;
let baseUrl = '';
let home: string;
let workspace: string;
let prevHome: string | undefined;
let events: EngineEvent[] = [];
let script: (body: { messages: { role: string; content?: unknown }[] }, idx: number) => string;

beforeAll(() => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const idx = (server as unknown as { __idx: number }).__idx ?? 0;
      (server as unknown as { __idx: number }).__idx = idx + 1;
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

afterAll(() => {
  server.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'dc-ws-'));
  prevHome = process.env.DEEPCODE_HOME;
  process.env.DEEPCODE_HOME = home;
  writeFileSync(join(workspace, 'hello.txt'), 'Hello, world\n', 'utf8');
  events = [];
  (server as unknown as { __idx: number }).__idx = 0;
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

async function makeEngine(
  handler: (body: { messages: { role: string }[] }, idx: number) => string,
  approval?: 'allow-all' | 'deny-all' | 'abort',
) {
  script = handler;
  const resolved = loadConfig({ workspace });
  resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
  resolved.config.permissions.mode = 'ask';
  const engine = new DeepcodeEngine({
    resolved,
    approvalHandler: async (items) => {
      if (approval === 'abort') return { decisions: [], aborted: true };
      const decisions: ApprovalResult['decisions'] = items.map((i) => ({
        callId: i.callId,
        action: approval === 'deny-all' ? 'deny' : 'allow',
      }));
      return { decisions, aborted: false };
    },
  });
  engine.onEvent((e) => events.push(e));
  await engine.init();
  return engine;
}

// ---------- test cases ----------

describe('integration: fake provider full loop', () => {
  it('perceive -> act -> observe -> finish: tool call with result backfill', async () => {
    const engine = await makeEngine((body, idx) => {
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (idx === 0) {
        return streamToolCalls([{ id: 'call-1', name: 'read_file', args: { path: 'hello.txt' } }]);
      }
      expect(hasToolResult).toBe(true);
      return streamText('File content read.', { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 800 });
    });

    const result = await engine.runTurn('read hello.txt');
    expect(result.stopReason).toBe('end_turn');
    expect(result.turns).toBeGreaterThanOrEqual(2);
    const trMsg = engine.session.messages.find((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'));
    expect(trMsg).toBeDefined();
    const tr = (trMsg!.content as { type: string; content: string }[]).find((b) => b.type === 'tool_result')!;
    expect(tr.content).toContain('Hello');
    const totals = engine.usage.totalsSnapshot();
    expect(totals.requests).toBe(2);
    expect(totals.inputTokens).toBe(1000 + 100);
    expect(totals.promptCacheHitTokens).toBe(800);
    expect(events.some((e) => e.type === 'tool-start')).toBe(true);
    expect(events.some((e) => e.type === 'tool-result')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    engine.close();
  });

  it('parallel tool calls: all tool_use in one response execute and backfill in order', async () => {
    const engine = await makeEngine((body, idx) => {
      if (idx === 0) {
        return streamToolCalls([
          { id: 'p1', name: 'read_file', args: { path: 'hello.txt' } },
          { id: 'p2', name: 'glob', args: { pattern: '*.txt' } },
        ]);
      }
      return streamText('All executed.');
    });

    await engine.runTurn('read in parallel');
    const trMsg = engine.session.messages.find((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'));
    const blocks = (trMsg!.content as { type: string; toolUseId: string; content: string }[]).filter((b) => b.type === 'tool_result');
    expect(blocks.map((b) => b.toolUseId)).toEqual(['p1', 'p2']);
    expect(blocks[0]!.content).toContain('Hello');
    expect(blocks[1]!.content).toContain('hello.txt');
    engine.close();
  });

  it('non-zero exit codes come back as isError (self-correction path)', async () => {
    const engine = await makeEngine((body, idx) => {
      if (idx === 0) {
        return streamToolCalls([{ id: 'e1', name: 'run_terminal_cmd', args: { command: 'node -e "process.exit(3)"' } }]);
      }
      return streamText('Exit code 3, understood the error.');
    });

    await engine.runTurn('run a failing command');
    const trMsg = engine.session.messages.find((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'));
    const tr = (trMsg!.content as { type: string; isError?: boolean; content: string }[]).find((b) => b.type === 'tool_result')!;
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain('exit code: 3');
    engine.close();
  });

  it('approval denial: denied tools do not run, the observation marks the denial', async () => {
    const engine = await makeEngine((body, idx) => {
      if (idx === 0) {
        return streamToolCalls([{ id: 'd1', name: 'write_file', args: { path: 'nope.txt', content: 'x' } }]);
      }
      return streamText('The write was denied.');
    }, 'deny-all');

    await engine.runTurn('write a file');
    expect(existsSync(join(workspace, 'nope.txt'))).toBe(false);
    const trMsg = engine.session.messages.find((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'));
    const tr = (trMsg!.content as { type: string; content: string; isError?: boolean }[]).find((b) => b.type === 'tool_result')!;
    expect(tr.content).toContain('denied');
    // A user-denied tool must still emit tool-result (settle its card), otherwise the streamed
    // "…" card never reaches a terminal state and the assistant message stays in the live region.
    expect(events.some((e) => e.type === 'tool-result' && e.callId === 'd1')).toBe(true);
    engine.close();
  });

  it('approval abort: backfills tool_result so the next request stays valid (no orphan tool_use)', async () => {
    // write_file (not read_file) so the approval gate does NOT auto-allow it — the batch must
    // reach the approval handler, which aborts it.
    const engine = await makeEngine((body, idx) => {
      if (idx === 0) return streamToolCalls([{ id: 'a1', name: 'write_file', args: { path: 'nope2.txt', content: 'x' } }]);
      // Second request must contain the backfilled tool result. An orphan tool_use (assistant
      // message with no matching result) makes the real APIs reject with HTTP 400; the handler
      // asserting on the body is the regression guard. OpenAI-compat serializes tool_result
      // blocks as role:'tool' messages (see openai-compat.ts toOpenAiMessages).
      const hasToolResult = body.messages.some(
        (m) => (m as { role?: string; tool_call_id?: string }).role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'a1',
      );
      expect(hasToolResult).toBe(true);
      return streamText('Turn continued after abort.');
    }, 'abort');

    const first = await engine.runTurn('write a file');
    expect(first.stopReason).toBe('tools-denied');
    expect(existsSync(join(workspace, 'nope2.txt'))).toBe(false); // aborted tools never run
    // The persisted conversation must end with a user message carrying the aborted tool_result.
    const last = engine.session.messages[engine.session.messages.length - 1]!;
    expect(typeof last.content).not.toBe('string');
    const blocks = last.content as { type: string; toolUseId?: string; isError?: boolean }[];
    const backfill = blocks.find((b) => b.type === 'tool_result' && b.toolUseId === 'a1');
    expect(backfill).toBeDefined();
    expect(backfill!.isError).toBe(true);
    expect(blocks.filter((b) => b.type === 'tool_result').length).toBe(1);

    const second = await engine.runTurn('continue');
    expect(second.stopReason).toBe('end_turn');
    engine.close();
  });

  it('session persists and can be restored (--continue semantics)', async () => {
    const engine = await makeEngine((body, idx) => {
      if (idx === 0) return streamToolCalls([{ id: 'r1', name: 'read_file', args: { path: 'hello.txt' } }]);
      return streamText('Read complete.');
    });
    await engine.runTurn('read');
    const sessionId = engine.session.id;
    engine.close();

    const resolved = loadConfig({ workspace });
    resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
    const { SessionStore } = await import('../src/session/store.js');
    const store = new SessionStore(resolved.paths.sessionsDir);
    const rec = store.load(sessionId);
    expect(rec).toBeDefined();
    expect(rec!.messages.length).toBeGreaterThan(2);
    expect(rec!.messages[0]!.role).toBe('user');
    expect(rec!.usage.length).toBeGreaterThan(0);
  });

  it('reasoner fallback: a tool-less model can still chat (thinking passthrough)', async () => {
    const engine = await makeEngine(() => {
      let out = '';
      out += streamChunk({ role: 'assistant', content: '' });
      out += streamChunk({ reasoning_content: 'reasoning process' });
      out += streamChunk({ content: 'conclusion' });
      out += streamChunk({}, 'stop');
      out += usageChunk({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 });
      out += DONE;
      return out;
    });
    const result = await engine.runTurn('simple question');
    expect(result.stopReason).toBe('end_turn');
    expect(result.turns).toBe(1);
    engine.close();
  });
});
