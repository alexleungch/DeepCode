import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render as inkRender } from 'ink';
import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import { DeepcodeTUI } from '../src/ui/app.js';
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '../src/providers/types.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal TTY-like stdout with a real `rows` count. */
class RowsStdout extends EventEmitter {
  columns = 100;
  rows = 24;
  isTTY = true;
  private buf = '';
  write = (s: string) => {
    this.buf += s;
    return true;
  };
  lastFrame = () => this.buf;
}
class RowsStdin extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  ref() {}
  unref() {}
  resume() {}
  pause() {}
}

const todoBlock = (id: string, todos: { content: string; status: string }[]) => ({
  type: 'tool_use' as const,
  id,
  name: 'todo_write',
  input: { todos },
});

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
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  try { rmSync(ws, { recursive: true, force: true }); } catch {}
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

const longAnswer = Array.from({ length: 40 }, (_, i) => `ANSWER line ${i}: content`).join('\n');

/**
 * Scenario C: the agent leaves one todo OPEN while streaming the final long answer — the
 * todo panel stays pinned above the input and steals viewport rows. Repro for
 * "todo list visible while running, then result never appears".
 */
function incompleteTodosProvider(): LLMProvider {
  let call = 0;
  return {
    id: 'deepseek',
    model: 'deepseek-chat',
    modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
    async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
      if (call++ === 0) {
        yield { type: 'text-delta', text: 'On it.' };
        yield {
          type: 'done',
          response: {
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'On it.' },
                todoBlock('c1', [
                  { content: 'scan repo', status: 'in_progress' },
                  { content: 'fix bug', status: 'pending' },
                  { content: 'verify', status: 'pending' },
                ]),
              ],
            },
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          },
        };
        return;
      }
      if (call === 2) {
        yield {
          type: 'done',
          response: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Work done but one todo still open' }, todoBlock('c2', [
                { content: 'scan repo', status: 'completed' },
                { content: 'fix bug', status: 'completed' },
                { content: 'verify', status: 'in_progress' },
              ])],
            },
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          },
        };
        return;
      }
      yield { type: 'text-delta', text: longAnswer };
      yield {
        type: 'done',
        response: { message: { role: 'assistant', content: longAnswer }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' },
      };
    },
    async complete() {
      throw new Error('not used');
    },
  };
}

function lastScreen(frame: string): string {
  const parts = frame.split(/\x1b\[2J\x1b\[3J\x1b\[H/);
  return (parts[parts.length - 1] ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Scenario A: the agent checks off EVERY todo before writing the final answer — the old
 *  TodoPanel hid itself at done===total, so the checklist vanished mid-run and the user lost
 *  the completion signal ("couldn't tell whether it finished"). */
function completesTodosProvider(): LLMProvider {
  let call = 0;
  return {
    id: 'deepseek',
    model: 'deepseek-chat',
    modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
    async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: 'text-delta', text: 'Starting' };
        yield {
          type: 'done',
          response: {
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Starting' },
                todoBlock('a1', [
                  { content: 'scan repo', status: 'in_progress' },
                  { content: 'fix bug', status: 'pending' },
                ]),
              ],
            },
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          },
        };
        return;
      }
      if (call === 2) {
        // Check every todo off in a final tool-only batch.
        yield {
          type: 'done',
          response: {
            message: {
              role: 'assistant',
              content: [
                todoBlock('a2', [
                  { content: 'scan repo', status: 'completed' },
                  { content: 'fix bug', status: 'completed' },
                ]),
              ],
            },
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          },
        };
        return;
      }
      yield { type: 'text-delta', text: 'All done\nComplete.' };
      yield {
        type: 'done',
        response: { message: { role: 'assistant', content: 'All done\nComplete.' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' },
      };
    },
    async complete() {
      throw new Error('not used');
    },
  };
}

describe('TUI todo panel vs final answer visibility', () => {
  it('REPRO: with an open todo left by the agent, the long final answer head is still visible', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = incompleteTodosProvider() as never;
    await engine.init();
    const stdout = new RowsStdout();
    const inst = inkRender(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }), {
      stdout: stdout as never,
      stdin: new RowsStdin() as never,
      stderr: new RowsStdout() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await wait(150);
    await engine.runTurn('check the repo');
    await wait(500);

    const frame = lastScreen(stdout.lastFrame());
    const lines = frame.split('\n');
    // Debug: dump the settled frame.
    console.log('--- settled frame ---\n' + lines.slice(0, 24).join('\n'));
    console.log('--- contains ANSWER line 0:', frame.includes('ANSWER line 0: content'));
    expect(frame).toContain('ANSWER line 0: content');
    expect(frame).toContain('Todo');
    inst.unmount();
    engine.close();
  });

  it('the todo panel stays visible with all-☑ after the agent completes every item (no vanish mid-run)', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = completesTodosProvider() as never;
    await engine.init();
    const stdout = new RowsStdout();
    const inst = inkRender(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }), {
      stdout: stdout as never,
      stdin: new RowsStdin() as never,
      stderr: new RowsStdout() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await wait(150);
    await engine.runTurn('check the repo');
    await wait(500);

    const frame = lastScreen(stdout.lastFrame());
    console.log('--- settled frame A ---\n' + frame.split('\n').slice(0, 20).join('\n'));
    // Panel is still there AFTER completion, showing the finished state — not vanished.
    expect(frame).toContain('Todo · 2/2');
    expect(frame).toContain('☑ scan repo');
    expect(frame).toContain('☑ fix bug');
    // And the final answer is on screen with it.
    expect(frame).toContain('Complete.');
    inst.unmount();
    engine.close();
  });
});