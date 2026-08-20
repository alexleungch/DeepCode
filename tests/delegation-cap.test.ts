import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import type { EngineEvent } from '../src/events.js';
import type { SubagentRuntime, SubagentResult } from '../src/agent/subagent.js';

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
/** A model that ALWAYS returns a tool_use (so segmentTurns keeps incrementing until the cap trips). */
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
let reqCount = 0;

beforeAll(() => {
  server = createServer((_req, res) => {
    const idx = (server as unknown as { __idx: number }).__idx ?? 0;
    (server as unknown as { __idx: number }).__idx = idx + 1;
    reqCount++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(streamToolCalls([{ id: `c${idx}`, name: 'read_file', args: { path: 'hello.txt' } }]));
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

async function makeEngine(opts: { maxTurns: number; maxTotalTurns: number; subagentsEnabled: boolean; mockSpawn?: () => Promise<SubagentResult> | SubagentResult }) {
  const resolved = loadConfig({ workspace });
  resolved.config.providers.deepseek = { apiKey: 'test-key', baseUrl };
  resolved.config.permissions.mode = 'ask';
  resolved.config.agent.maxTurns = opts.maxTurns;
  resolved.config.agent.maxTotalTurns = opts.maxTotalTurns;
  resolved.config.subagents.enabled = opts.subagentsEnabled;
  const engine = new DeepcodeEngine({
    resolved,
    approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
  });
  engine.onEvent((e) => events.push(e));
  await engine.init();
  if (opts.mockSpawn) {
    // Inject a stub SubagentRuntime so the parent loop's delegation attempt doesn't recurse into
    // runSubagent (which would itself hit the fake SSE). Real runSubagent behavior is covered
    // by subagent.test.ts / integration tests elsewhere.
    const mock: SubagentRuntime = {
      activeCount: 0,
      spawn: async () => opts.mockSpawn!(),
    };
    (engine as unknown as { subagentRuntime: SubagentRuntime }).subagentRuntime = mock;
  }
  return engine;
}

describe('segment-cap delegation', () => {
  it('delegates to subagent when segment cap trips and compaction cannot reduce (subagents enabled)', async () => {
    const engine = await makeEngine({
      maxTurns: 3,
      maxTotalTurns: 100,
      subagentsEnabled: true,
      mockSpawn: async () => ({
        subagentId: 'sub-test',
        label: 'segment-cap delegation',
        report: '# Subagent report\nAll remaining work done.',
        turns: 5,
        interrupted: false,
        stopReason: 'end_turn',
        tokensUsed: 1000,
      }),
    });

    const result = await engine.runTurn('loop forever');

    // The parent handed off to a subagent instead of stopping.
    expect(result.stopReason).toBe('delegated');
    // The subagent's report was appended as the final assistant message.
    const lastAssistant = [...engine.session.messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    expect(typeof lastAssistant!.content).toBe('string');
    expect(lastAssistant!.content as string).toContain('Subagent report');
    // The 'delegated' event was emitted (and the matching turn-end was too).
    expect(events.some((e) => e.type === 'delegated')).toBe(true);
    expect(events.some((e) => e.type === 'turn-end' && (e as { stopReason: string }).stopReason === 'delegated')).toBe(true);
    // No fatal 'max-turns' or 'over-budget' error was emitted (the fatal-stop path was bypassed).
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('segment (compaction did not reduce'))).toBe(false);

    engine.close();
  });

  it('falls back to reset+continue when subagents are disabled (eventually hits maxTotalTurns)', async () => {
    const engine = await makeEngine({ maxTurns: 3, maxTotalTurns: 5, subagentsEnabled: false });

    const result = await engine.runTurn('loop forever');

    // The hard backstop fires after enough cycles of (segment cap → reset → repeat).
    expect(result.stopReason).toBe('max-total-turns');
    // The informational "Continuing" error was emitted at least once (from the fallback path).
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('Continuing'))).toBe(true);
    // The hard-total-turns error was emitted after the for-loop exits.
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('hard total-turn limit'))).toBe(true);
    // No delegation was attempted.
    expect(events.some((e) => e.type === 'delegated')).toBe(false);

    engine.close();
  });
});