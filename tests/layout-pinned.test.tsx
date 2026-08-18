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

let home: string; let ws: string; let prevHome: string | undefined;
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

describe('TUI pinned layout (fullscreen)', () => {
  it('anchors the input box and status bar to the bottom of the terminal', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
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
    const frame = stdout.lastFrame();
    const lines = frame.split('\n');
    // The status bar (bottom info bar) is the very last block: its border + the [AUTO] badge.
    const joinedTail = lines.slice(-6).join('\n');
    expect(joinedTail).toContain('[AUTO]');
    // The input box (send message bar) sits right above the status bar, with its own border.
    const idxStatus = lines.findIndex((l) => l.includes('[AUTO]'));
    expect(idxStatus).toBeGreaterThan(-1);
    // The header is at the top (line 0 carries the model name).
    expect(lines[0] ?? '').toContain('deepseek-chat');
    // The input box's placeholder sits ABOVE the status bar (send bar above bottom info bar).
    const idxInput = lines.findIndex((l) => l.includes('Type a message'));
    expect(idxInput).toBeGreaterThan(-1);
    expect(idxInput).toBeLessThan(idxStatus);
    inst.unmount();
    engine.close();
  });
});
