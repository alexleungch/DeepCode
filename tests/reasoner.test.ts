import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonToolCalls, buildJsonToolSystem, isJsonToolModel, toOpenAiMessages } from '../src/providers/openai-compat.js';
import type { ToolSchema, LLMRequest, ChatMessage } from '../src/providers/types.js';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import type { ApprovalResult } from '../src/tools/permission.js';

describe('parseJsonToolCalls (JSON tool protocol parsing)', () => {
  it('parses a standard JSON tool call', () => {
    const raw = '{"tool_calls": [{"name": "read_file", "arguments": {"path": "a.ts"}}]}';
    const parsed = parseJsonToolCalls(raw);
    expect(parsed?.toolCalls).toHaveLength(1);
    expect(parsed?.toolCalls[0]?.name).toBe('read_file');
    expect(parsed?.toolCalls[0]?.arguments).toEqual({ path: 'a.ts' });
  });

  it('tolerates a markdown code fence', () => {
    const raw = '```json\n{"tool_calls": [{"name": "glob", "arguments": {"pattern": "**/*.ts"}}]}\n```';
    const parsed = parseJsonToolCalls(raw);
    expect(parsed?.toolCalls[0]?.name).toBe('glob');
  });

  it('parses the response field', () => {
    const parsed = parseJsonToolCalls('{"response": "done"}');
    expect(parsed?.response).toBe('done');
    expect(parsed?.toolCalls).toHaveLength(0);
  });

  it('re-parses when arguments is a string', () => {
    const raw = '{"tool_calls": [{"name": "x", "arguments": "{\\"a\\": 1}"}]}';
    const parsed = parseJsonToolCalls(raw);
    expect(parsed?.toolCalls[0]?.arguments).toEqual({ a: 1 });
  });

  it('multiple parallel tool calls', () => {
    const raw = '{"tool_calls": [{"name": "a", "arguments": {}}, {"name": "b", "arguments": {}}]}';
    const parsed = parseJsonToolCalls(raw);
    expect(parsed?.toolCalls).toHaveLength(2);
  });

  it('non-JSON text returns null', () => {
    expect(parseJsonToolCalls('Sorry, I cannot do that')).toBeNull();
    expect(parseJsonToolCalls('')).toBeNull();
  });

  it('entries missing a name are skipped', () => {
    const raw = '{"tool_calls": [{"arguments": {}}, {"name": "ok", "arguments": {}}]}';
    const parsed = parseJsonToolCalls(raw);
    expect(parsed?.toolCalls).toHaveLength(1);
    expect(parsed?.toolCalls[0]?.name).toBe('ok');
  });
});

describe('buildJsonToolSystem / isJsonToolModel', () => {
  const tools: ToolSchema[] = [
    { name: 'read_file', description: 'read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];

  it('system appends the tool catalog and contract', () => {
    const sys = buildJsonToolSystem('base', tools);
    expect(sys).toContain('tool calling protocol');
    expect(sys).toContain('read_file');
    expect(sys).toContain('"tool_calls"');
    expect(sys.startsWith('base')).toBe(true);
  });

  it('does not append when there are no tools', () => {
    expect(buildJsonToolSystem('base', [])).toBe('base');
  });

  it('model detection: reasoner and explicit config', () => {
    const cfg = loadConfig().config;
    expect(isJsonToolModel(cfg, 'deepseek-reasoner')).toBe(true);
    expect(isJsonToolModel(cfg, 'deepseek-chat')).toBe(false);
    cfg.modelMeta['custom-r'] = { toolCallProtocol: 'json' };
    expect(isJsonToolModel(cfg, 'custom-r')).toBe(true);
  });
});

// ---------- end-to-end: reasoner JSON protocol loop ----------

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const DONE = 'data: [DONE]\n\n';
function streamChunk(delta: Record<string, unknown>, finish_reason: string | null = null): string {
  return sse({ id: 'r1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-reasoner', choices: [{ index: 0, delta, finish_reason }] });
}
function usageChunk(usage: Record<string, number>): string {
  return sse({ id: 'r1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-reasoner', choices: [], usage });
}
function jsonTextStream(json: string, reasoning?: string): string {
  let out = '';
  out += streamChunk({ role: 'assistant', reasoning_content: reasoning ?? 'Analyzing…' });
  for (let i = 0; i < json.length; i += 8) {
    out += streamChunk({ content: json.slice(i, i + 8) });
  }
  out += streamChunk({}, 'stop');
  out += usageChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 60 });
  out += DONE;
  return out;
}

let server: Server;
let baseUrl = '';
let home: string;
let ws: string;
let prevHome: string | undefined;
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
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(() => server.close());

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rs-home-'));
  ws = mkdtempSync(join(tmpdir(), 'rs-ws-'));
  prevHome = process.env.DEEPCODE_HOME;
  process.env.DEEPCODE_HOME = home;
  writeFileSync(join(ws, 'hello.txt'), 'Hello, world\n');
  (server as unknown as { __idx: number }).__idx = 0;
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

describe('reasoner JSON protocol end-to-end (fake server)', () => {
  it('tool call -> result backfill -> final answer full loop', async () => {
    const requestBodies: { messages: { role: string; content?: unknown }[] }[] = [];
    script = (body, idx) => {
      requestBodies.push(body);
      if (idx === 0) {
        // first turn: JSON tool call (reasoning + content chunks)
        return jsonTextStream('{"tool_calls": [{"name": "read_file", "arguments": {"path": "hello.txt"}}]}', 'need to read the file content');
      }
      // second turn: assert the tool result was backfilled as text
      const hasToolResult = JSON.stringify(body).includes('tool result read_file');
      expect(hasToolResult).toBe(true);
      expect(body.messages[0]!.role).toBe('system');
      expect(JSON.stringify(body.messages[0])).toContain('tool calling protocol');
      return jsonTextStream('{"response": "The file content is: Hello, world"}');
    };

    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl };
    const engine = new DeepcodeEngine({
      resolved,
      approvalHandler: async (items): Promise<ApprovalResult> => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
    });
    await engine.init();
    // force the reasoner model (the engine defaults to deepseek-chat)
    engine.setModel('deepseek-reasoner');

    const result = await engine.runTurn('read hello.txt');
    expect(result.stopReason).toBe('end_turn');
    expect(result.turns).toBe(2);
    // the session contains the tool execution and the final answer (text block form)
    const finalText = result.messages
      .map((m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')))
      .join('');
    expect(finalText).toContain('Hello, world');
    // the second request used the JSON protocol (no tools param, system output contract)
    const second = requestBodies[1]!;
    expect(second.messages[0]!.role).toBe('system');
    // usage booking includes cache hits (60 per turn)
    expect(engine.usage.totalsSnapshot().promptCacheHitTokens).toBe(120);
    engine.close();
  });

  it('non-JSON output degrades to plain text (no interruption)', async () => {
    script = () => jsonTextStream('Sorry, I cannot call tools, but the conclusion is X');
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl };
    const engine = new DeepcodeEngine({
      resolved,
      approvalHandler: async () => ({ decisions: [], aborted: false }),
    });
    await engine.init();
    engine.setModel('deepseek-reasoner');
    const result = await engine.runTurn('question');
    expect(result.stopReason).toBe('end_turn');
    expect(result.turns).toBe(1);
    engine.close();
  });
});

describe('toOpenAiMessages (assistant message serialization)', () => {
  const req = (messages: ChatMessage[]): LLMRequest => ({
    system: 'sys',
    messages,
    tools: [],
    maxTokens: 1024,
    signal: new AbortController().signal,
  });

  it('never serializes an empty-text assistant message to content: null without tool_calls (regression: DeepSeek 400 "Invalid assistant message")', () => {
    const out = toOpenAiMessages(
      req([{ role: 'assistant', content: [{ type: 'text', text: '' }] }]),
    );
    expect(out[0]).toEqual({ role: 'assistant', content: ' ' });
  });

  it('keeps content: null only when tool_calls are present', () => {
    const out = toOpenAiMessages(
      req([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'ls', input: { dir: '.' } }],
        },
      ]),
    );
    expect(out[0]!.content).toBeNull();
    expect(out[0]).toHaveProperty('tool_calls');
    expect((out[0] as { tool_calls: { function: { name: string } }[] }).tool_calls[0]!.function.name).toBe('ls');
  });

  it('round-trips text + tool calls in a single assistant message', () => {
    const out = toOpenAiMessages(
      req([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 't2', name: 'glob', input: { pattern: '**/*.ts' } },
          ],
        },
      ]),
    );
    expect(out[0]!.content).toBe('Let me check');
    expect(out[0]).toHaveProperty('tool_calls');
  });
});
