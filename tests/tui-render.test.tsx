import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import { DeepcodeTUI } from '../src/ui/app.js';
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent } from '../src/providers/types.js';

/** Fake provider: fixed scripted stream */
const scriptedProvider = (script: (req: LLMRequest, idx: number) => LLMStreamEvent[]): LLMProvider => {
  let idx = 0;
  return {
    id: 'deepseek',
    model: 'deepseek-chat',
    modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
    async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
      for (const e of script(req, idx++)) yield e;
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

describe('TUI render smoke (ink-testing-library)', () => {
  it('renders the empty state: the status bar shows the model info', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = scriptedProvider(() => []) as never;
    await engine.init();
    const { lastFrame, unmount } = render(
      React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('deepseek-chat');
    expect(frame).toContain('tui-ws'); // workspace path shown in the status bar
    unmount();
    engine.close();
  });

  it('info stays at the bottom: the status bar renders after the input', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = scriptedProvider(() => []) as never;
    await engine.init();
    const { lastFrame, unmount } = render(
      React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    // With <Static> + native scrollback the layout flows top-down (no fixed-height dock), so
    // the frame is no longer top-padded with blank lines.
    expect(frame.startsWith('\n')).toBe(false);
    // The status bar (info) renders after the input, i.e. closer to the bottom.
    expect(frame.indexOf('deepseek-chat')).toBeGreaterThan(frame.indexOf('Type a message'));
    // The last non-empty line of the frame is the status bar bottom border.
    const nonEmpty = frame.split('\n').filter((l) => l.trim() !== '');
    expect(nonEmpty[nonEmpty.length - 1]!.trimEnd().endsWith('╯')).toBe(true);
    unmount();
    engine.close();
  });

  it('streaming render: text-delta appears in the frame', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = scriptedProvider(() => [
      { type: 'text-delta', text: 'Hello ' },
      { type: 'text-delta', text: 'world' },
      { type: 'done', response: { message: { role: 'assistant', content: 'Hello world' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' } },
    ]) as never;
    await engine.init();
    const { lastFrame, unmount } = render(
      React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }),
    );
    await engine.runTurn('test');
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Hello');
    expect(frame).toContain('world');
    unmount();
    engine.close();
  });

  it('tool call card rendering', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = scriptedProvider(() => [
      { type: 'text-delta', text: 'Start' },
      { type: 'tool-start', id: 'c1', name: 'read_file' },
      { type: 'tool-input-delta', id: 'c1', partialJson: '{"path":"a.ts"}' },
      { type: 'done', response: { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_use' } },
    ]) as never;
    engine.setApprovalHandler(async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'deny' })), aborted: false }));
    await engine.init();
    const { lastFrame, unmount } = render(
      React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }),
    );
    await engine.runTurn('read file');
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('read_file');
    unmount();
    engine.close();
  });
});
