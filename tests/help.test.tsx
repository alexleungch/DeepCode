import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, type Instance } from 'ink-testing-library';
import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import { DeepcodeTUI } from '../src/ui/app.js';
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '../src/providers/types.js';

const silentProvider = (): LLMProvider => ({
  id: 'deepseek',
  model: 'deepseek-chat',
  modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
  async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    return;
  },
  async complete() {
    throw new Error('not used');
  },
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Type text char-by-char, then a lone CR (Ink maps a standalone \r to key.return in tests) */
async function type(inst: Instance, text: string) {
  for (const ch of text) {
    inst.stdin.write(ch);
    await wait(6);
  }
  inst.stdin.write('\r');
  await wait(200);
}

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

describe('TUI /help notice: superseded by the next submission', () => {
  async function setup() {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    resolved.config.providers.ollama = { baseUrl: 'http://localhost:11434' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = silentProvider() as never;
    await engine.init();
    const inst = render(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }));
    await wait(120);
    return { engine, inst };
  }

  it('shows the help text after /help', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/help');
    expect(inst.lastFrame() ?? '').toContain('Available commands:');
    inst.unmount();
    engine.close();
  });

  it('a plain message replaces the help notice immediately', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/help');
    expect(inst.lastFrame() ?? '').toContain('Available commands:');

    // Any new submission supersedes the help notice: the notice must vanish from the
    // live region while the user message appears above it.
    await type(inst, 'hello');
    await wait(300);
    const frame = inst.lastFrame() ?? '';
    expect(frame).not.toContain('Available commands:');
    expect(frame).toContain('❯ hello');
    inst.unmount();
    engine.close();
  });

  it('another slash command replaces the help notice too', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/help');
    expect(inst.lastFrame() ?? '').toContain('Available commands:');

    await type(inst, '/models');
    const frame = inst.lastFrame() ?? '';
    expect(frame).not.toContain('Available commands:');
    expect(frame).toContain('Available providers:');
    inst.unmount();
    engine.close();
  });

  it('a repeated /help still shows the help text (group replacement intact)', async () => {
    const { engine, inst } = await setup();
    for (let i = 0; i < 2; i++) {
      await type(inst, '/help');
    }
    expect(inst.lastFrame() ?? '').toContain('Available commands:');
    inst.unmount();
    engine.close();
  });
});
