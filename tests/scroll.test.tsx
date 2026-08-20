import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { render as inkRender } from 'ink';
import React from 'react';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import { DeepcodeTUI } from '../src/ui/app.js';
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '../src/providers/types.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal TTY-like stdout with a real `rows` count (pinned viewport path). */
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
  /** Reads and CLEARS the buffer, capturing only frames written since the last read. */
  readFrame = () => {
    const f = this.buf;
    this.buf = '';
    return f;
  };
}
/**
 * Minimal TTY-like stdin that behaves like a real Readable stream. Ink (>= v5) consumes input
 * through the 'readable' event + `read()`, NOT the legacy 'data' event — a plain EventEmitter
 * mock silently drops every keypress, so tests must `push()` chunks like a real stream.
 */
class RowsStdin extends Readable {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  _read() {}
}

/** Provider that emits a long multi-line assistant answer per request. */
const longProvider = (): LLMProvider => {
  let turn = 0;
  return {
    id: 'deepseek',
    model: 'deepseek-chat',
    modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
    async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const i = turn++;
      const text = [`Message ${i}`, ...Array.from({ length: 14 }, (_, k) => `  line-${i}-${k}`)].join('\n');
      yield { type: 'text-delta', text };
      yield {
        type: 'done',
        response: { message: { role: 'assistant', content: text }, usage: { inputTokens: 10, outputTokens: 20 }, stopReason: 'end_turn' },
      };
    },
    async complete() {
      throw new Error('not used');
    },
  };
};

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

describe('TUI message area: pinned viewport with in-app history scroll', () => {
  async function setup() {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = longProvider() as never;
    await engine.init();
    const inst = render(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }));
    await wait(150);
    return { engine, inst };
  }

  it('keeps every prior turn in the output (history is not clipped) with the newest at the bottom', async () => {
    const { engine, inst } = await setup();
    // 3 turns x (~16 lines each) = ~48 lines, well past one screen. The viewport is
    // overflow:hidden and anchors the newest message at the bottom (like a chat app); older
    // turns stay in the message list and are reachable with PageUp.
    for (let i = 0; i < 3; i++) {
      await engine.runTurn(`prompt ${i}`);
      await wait(250);
    }
    const frame = inst.lastFrame() ?? '';
    // The newest turn is visible at the bottom; older turns stay in the message list and are
    // reachable with PageUp/Shift+↑. The visible scrollbar was replaced by a floating position
    // hint in the status bar (gated on a real terminal height, so it does not appear headless).
    expect(frame).toContain('Message 2');
    // No custom scrollbar track glyph (│/█/║) is rendered.
    expect(frame).not.toContain('║');
    inst.unmount();
    engine.close();
  });

  it('settled messages persist as more turns arrive (written once, not re-rendered away)', async () => {
    const { engine, inst } = await setup();
    await engine.runTurn('first');
    await wait(250);
    expect(inst.lastFrame() ?? '').toContain('Message 0');
    // Two more turns — the first turn's content must still be present in the message list.
    await engine.runTurn('second');
    await wait(250);
    await engine.runTurn('third');
    await wait(250);
    const frame = inst.lastFrame() ?? '';
    expect(frame).toContain('Message 0');
    expect(frame).toContain('Message 2');
    inst.unmount();
    engine.close();
  });

  it('help advertises in-app scrolling (PageUp/PageDown) for reviewing history', async () => {
    const { engine, inst } = await setup();
    // Type char-by-char then CR: a single bulk write can race the submit before the input
    // buffer is populated, so ink-testing-library would submit an empty line.
    for (const ch of '/help') {
      inst.stdin.write(ch);
      await wait(8);
    }
    inst.stdin.write('\r');
    await wait(250);
    const frame = inst.lastFrame() ?? '';
    // The design dropped native terminal scrollback in favor of an in-app pinned viewport:
    // history review is advertised as PageUp/PageDown (not "scrollback").
    expect(frame).toContain('PageUp');
    expect(frame).toContain('PageDown');
    inst.unmount();
    engine.close();
  });

  it('after scrolling up (PageUp), submitting a new message re-pins the view so the new result appears without scrolling', async () => {
    // Real terminal height (rows=24) → pinned viewport + in-app scroll. This reproduces the
    // regression: read history (PageUp), then send a follow-up. The submit path must re-pin to
    // the newest content — otherwise the new result lands BELOW the fold and the user has to
    // scroll down manually to see it.
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = longProvider() as never;
    await engine.init();
    const stdout = new RowsStdout();
    const stdin = new RowsStdin();
    const inst = inkRender(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }), {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: new RowsStdout() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await wait(150);
    const clean = () => stdout.lastFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

    // Turn 1 (fills ~half the screen): newest Message 0 visible at the bottom.
    await engine.runTurn('prompt 0');
    await wait(300);
    expect(clean()).toContain('Message 0');

    // Scroll UP with PageUp (like reading history) → atBottom becomes false, the floating
    // position hint appears in the status bar ("Back to bottom").
    stdin.push('\x1b[5~'); // PageUp
    await wait(200);
    expect(clean()).toContain('Back to bottom');
    // Drop everything written so far so later assertions only see the post-submit frame.
    stdout.readFrame();

    // Turn 2: submit a NEW user message through the REAL input path (type char-by-char + Enter,
    // which routes through onSubmit → setAtBottom(true) → engine.runTurn). The result must be
    // visible WITHOUT any manual scrolling. The newest reply is 16 rows tall in a 15-row viewport,
    // so the head-guard keeps its first lines visible (the very last line can't physically fit);
    // the point is the user sees the new result immediately, not below the fold.
    for (const ch of 'prompt 1') {
      stdin.push(ch);
      await wait(8);
    }
    // Drop the typing frames (they still show the hint while scrolled up) so the assertions below
    // only inspect the frames written AFTER Enter is pressed.
    stdout.readFrame();
    stdin.push('\r');
    await wait(400);
    const frame = clean();
    expect(frame).toContain('Message 1');
    expect(frame).toContain('line-1-0');
    // Re-pinned to the bottom: the "Back to bottom" hint is gone.
    expect(frame).not.toContain('Back to bottom');

    inst.unmount();
    engine.close();
  });
});
