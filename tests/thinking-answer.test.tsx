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

/** Minimal TTY-like stdout with a real `rows` count (the property Ink keys fullscreen off). */
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

/** Provider: thinking phase (no text) then a LONG answer that overflows one screen. */
const thinkThenLongAnswer = (): LLMProvider => ({
  id: 'deepseek',
  model: 'deepseek-chat',
  modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
  async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const thinking = Array.from({ length: 20 }, (_, i) => `thinking line ${i}`).join('\n');
    const text = Array.from({ length: 30 }, (_, i) => `ANSWER line ${i}: content`).join('\n');
    for (let i = 0; i < thinking.length; i += 40) yield { type: 'thinking-delta', text: thinking.slice(i, i + 40) };
    yield { type: 'text-delta', text };
    yield { type: 'done', response: { message: { role: 'assistant', content: text }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' } };
  },
  async complete() {
    throw new Error('not used');
  },
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

describe('TUI thinking → long answer (viewport head guard)', () => {
  it('after a thinking phase, the long final answer is visible from its FIRST line (no manual scroll needed)', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = thinkThenLongAnswer() as never;
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
    await engine.runTurn('question');
    await wait(400);
    // Take the LAST clear-screen frame (final settled view, not intermediate ANSI deltas).
    const parts = stdout.lastFrame().split(/\x1b\[2J\x1b\[3J\x1b\[H/);
    const finalScreen = (parts[parts.length - 1] ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    // The head of the answer is visible without scrolling: line 0 and the first few lines.
    expect(finalScreen).toContain('ANSWER line 0: content');
    expect(finalScreen).toContain('ANSWER line 1: content');
    // The thinking phase itself is collapsed after the turn (Ctrl+O reveals it), so the raw
    // reasoning text is NOT dumped into the answer viewport.
    expect(finalScreen).not.toContain('thinking line');
    inst.unmount();
    engine.close();
  });
});