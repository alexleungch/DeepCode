import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import { DeepcodeTUI } from '../src/ui/app.js';
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '../src/providers/types.js';
import type { ToolDef, ToolResult } from '../src/tools/types.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleep = wait;

let home: string;
let ws: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tui-home-'));
  ws = mkdtempSync(join(tmpdir(), 'tui-ws-'));
  prevHome = process.env.DEEPCODE_HOME;
  process.env.DEEPCODE_HOME = home;
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {}
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

function baseProvider(): LLMProvider {
  return {
    id: 'deepseek',
    model: 'deepseek-chat',
    modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
    async *stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', response: { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' } };
    },
    async complete() {
      throw new Error('not used');
    },
  };
}

/** Command that runs ~3-4s on both platforms (blocks the event loop for the test duration). */
const slowCommand = () => (process.platform === 'win32' ? 'ping -n 4 127.0.0.1 > nul' : 'sleep 3');

describe('P0#1 interrupt during tool execution stops the tool promptly and settles the card', () => {
  it('an interrupt while a slow terminal command runs ends the turn quickly and the card settles', async () => {
    let call = 0;
    const provider: LLMProvider = {
      ...baseProvider(),
      async *stream(): AsyncIterable<LLMStreamEvent> {
        if (call++ === 0) {
          yield { type: 'text-delta', text: 'Running' };
          yield {
            type: 'done',
            response: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'Running' },
                  { type: 'tool_use', id: 'c1', name: 'run_terminal_cmd', input: { command: slowCommand() } },
                ],
              },
              usage: { inputTokens: 10, outputTokens: 5 },
              stopReason: 'tool_use',
            },
          };
          return;
        }
        yield { type: 'text-delta', text: 'Final' };
        yield { type: 'done', response: { message: { role: 'assistant', content: 'Final' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' } };
      },
    };

    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = provider as never;
    engine.gate.remember({ callId: 'x', toolName: 'run_terminal_cmd', command: slowCommand(), risk: 'low' as never, action: 'allow-always' });
    await engine.init();
    const inst = render(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }));

    const turn = engine.runTurn('run slow');
    await wait(500); // let the tool actually start

    const startedAt = Date.now();
    engine.interrupt();
    const result = await Promise.race([
      turn,
      sleep(2500).then(() => 'TIMEOUT' as const),
    ]);
    const elapsed = Date.now() - startedAt;

    // The turn must end promptly after interrupt (the tool must NOT run its full 3-4s)
    expect(result).not.toBe('TIMEOUT');
    expect(elapsed).toBeLessThan(2500);
    // The tool card must be settled with an error/interrupted result (not stuck streaming "…")
    await wait(200);
    const frame = inst.lastFrame() ?? '';
    expect(frame).toMatch(/[✗✓]\s+Bash \(/);

    inst.unmount();
    engine.close();
  });
});

describe('P0#1 Ctrl+C during an approval dialog aborts the batch instead of hanging', () => {
  it('Ctrl+C while the dialog is open resolves the turn (no eternal approval wait)', async () => {
    // A tool that REQUIRES approval (run_terminal_cmd is always pending in ask mode, not pre-allowed)
    const provider: LLMProvider = {
      ...baseProvider(),
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: 'text-delta', text: 'Needs approval' };
        yield {
          type: 'done',
          response: {
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Needs approval' },
                { type: 'tool_use', id: 'c1', name: 'run_terminal_cmd', input: { command: 'echo hi' } },
              ],
            },
            usage: { inputTokens: 5, outputTokens: 5 },
            stopReason: 'tool_use',
          },
        };
        return;
      },
    };

    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = provider as never;
    await engine.init();
    const inst = render(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }));

    const turn = engine.runTurn('needs approval');
    await wait(400); // dialog should be showing

    const before = inst.lastFrame() ?? '';
    expect(before).toContain('Approval required');

    // Simulate Ctrl+C while the dialog is open (Ink maps \x03 to ctrl+c)
    inst.stdin.write('\x03');
    const result = await Promise.race([
      turn,
      sleep(2500).then(() => 'TIMEOUT' as const),
    ]);

    // The turn must NOT hang forever waiting on the approval handler
    expect(result).not.toBe('TIMEOUT');
    await wait(200);
    const after = inst.lastFrame() ?? '';
    expect(after).not.toContain('Approval required');

    inst.unmount();
    engine.close();
  });
});

describe('P0#2 interrupt() is scoped to the turn (no cross-turn contamination)', () => {
  it('interrupt() with no running turn does not poison the next runTurn', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = baseProvider() as never;
    await engine.init();

    // No turn in flight — interrupt should be a harmless no-op
    engine.interrupt();

    const result = await Promise.race([
      engine.runTurn('after idle interrupt'),
      sleep(3000).then(() => 'TIMEOUT' as const),
    ]);
    expect(result).not.toBe('TIMEOUT');
    expect(result?.interrupted).toBe(false);
    engine.close();
  });

  it('an interrupt during turn A does not abort a later turn B started after it settled', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = baseProvider() as never;
    await engine.init();

    const t1 = engine.runTurn('first');
    await wait(100);
    engine.interrupt(); // aborts turn A mid-stream
    await t1; // resolves (possibly with interrupted=true)

    const t2 = await Promise.race([
      engine.runTurn('second'),
      sleep(3000).then(() => 'TIMEOUT' as const),
    ]);
    // A clean later turn must not inherit the abort
    expect(t2).not.toBe('TIMEOUT');
    expect(t2?.interrupted).toBe(false);
    engine.close();
  });
});

describe('P0#1 abort-aware custom tools (executor + tool defs see the abort)', () => {
  it('a tool whose execute awaits ctx.signal settles with an interrupted result instead of hanging', async () => {
    // Tool that only resolves when its ctx.signal aborts (models a long-running tool)
    const blockingTool: ToolDef = {
      name: 'blocker',
      description: 'blocks until interrupt',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      permission: 'execute',
      async execute(_input: unknown, ctx: { signal?: AbortSignal }): Promise<ToolResult> {
        return new Promise((resolve) => {
          if (ctx.signal?.aborted) return resolve({ content: 'interrupted (pre-aborted)', isError: true });
          ctx.signal?.addEventListener('abort', () => resolve({ content: 'interrupted', isError: true }), { once: true });
        });
      },
    };

    let call = 0;
    const provider: LLMProvider = {
      ...baseProvider(),
      async *stream(): AsyncIterable<LLMStreamEvent> {
        if (call++ === 0) {
          yield { type: 'text-delta', text: 'block' };
          yield { type: 'done', response: { message: { role: 'assistant', content: [{ type: 'text', text: 'block' }, { type: 'tool_use', id: 'c1', name: 'blocker', input: {} }] }, usage: { inputTokens: 5, outputTokens: 5 }, stopReason: 'tool_use' } };
          return;
        }
        yield { type: 'text-delta', text: 'done' };
        yield { type: 'done', response: { message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 5, outputTokens: 5 }, stopReason: 'end_turn' } };
      },
    };

    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = provider as never;
    engine.registry.register(blockingTool);
    engine.gate.remember({ callId: 'x', toolName: 'blocker', command: '', risk: 'low' as never, action: 'allow-always' });
    await engine.init();

    const turn = engine.runTurn('block');
    await wait(300); // tool is now waiting on ctx.signal
    engine.interrupt();

    const result = await Promise.race([turn, sleep(3000).then(() => 'TIMEOUT' as const)]);
    expect(result).not.toBe('TIMEOUT');
    expect(result?.interrupted).toBe(true);
    engine.close();
  });
});