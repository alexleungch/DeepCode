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
    // With the pinned layout (Header + viewport + input + status bar) the frame is not
    // top-padded with blank lines: the Header row is the first content.
    expect(frame.startsWith('\n')).toBe(false);
    // The status bar (bottom box) renders AFTER the input: its mode badge [AUTO] must appear
    // lower in the frame than the input placeholder. (The model name alone is ambiguous now —
    // it also appears in the top Header.)
    expect(frame.indexOf('[AUTO]')).toBeGreaterThan(frame.indexOf('Type a message'));
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

  it('thinking -> text: result appears after a reasoning phase (thinking-delta then text-delta)', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = scriptedProvider(() => [
      // reasoning phase first: only thinking, no text yet
      { type: 'thinking-delta', text: 'Let me reason about this carefully...' },
      { type: 'thinking-delta', text: ' The answer is simple.' },
      // final answer arrives after the thinking phase
      { type: 'text-delta', text: 'The answer is ' },
      { type: 'text-delta', text: '42' },
      { type: 'done', response: { message: { role: 'assistant', content: 'The answer is 42' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' } },
    ]) as never;
    await engine.init();
    const { lastFrame, unmount } = render(
      React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }),
    );
    await engine.runTurn('what is the answer?');
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? '';
    // The visible result must appear after the thinking phase
    expect(frame).toContain('The answer is 42');
    unmount();
    engine.close();
  });

  it('thinking-only turn: thinking IS the visible answer', async () => {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = scriptedProvider(() => [
      // model produced ONLY reasoning — no text, no tool calls
      { type: 'thinking-delta', text: 'The model only reasoned here' },
      { type: 'done', response: { message: { role: 'assistant', content: '' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' } },
    ]) as never;
    await engine.init();
    const { lastFrame, unmount } = render(
      React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }),
    );
    await engine.runTurn('think only');
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? '';
    // thinking-only content is rendered as the answer (state.ts turn-end / MessageList thinkingOnlyAnswer)
    expect(frame).toContain('The model only reasoned here');
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
