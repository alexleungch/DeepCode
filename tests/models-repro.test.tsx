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

describe('TUI /models notices: only the latest /models output stays (list replaced on success/failure)', () => {
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

  it('a successful switch replaces the list; only the success notice stays', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/models');
    expect(inst.lastFrame() ?? '').toContain('Available providers:');

    await type(inst, '/models deepseek deepseek-chat');
    const frame = inst.lastFrame() ?? '';
    expect(frame).toContain('Switched to DeepSeek');
    expect(frame).not.toContain('Available providers:');
    inst.unmount();
    engine.close();
  });

  it('a failed switch replaces the list; only the red error stays', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/models');
    expect(inst.lastFrame() ?? '').toContain('Available providers:');

    await type(inst, '/models bogus');
    const frame = inst.lastFrame() ?? '';
    expect(frame).toContain('Unknown vendor "bogus"');
    expect(frame).not.toContain('Available providers:');
    inst.unmount();
    engine.close();
  });

  it('repeated /models runs replace the old list (single copy)', async () => {
    const { engine, inst } = await setup();
    for (let i = 0; i < 3; i++) {
      await type(inst, '/models');
    }
    const frame = inst.lastFrame() ?? '';
    expect((frame.match(/Available providers:/g) ?? []).length).toBe(1);
    inst.unmount();
    engine.close();
  });

  it('a later message clears the /models notice (mirrors /help behavior)', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/models');
    expect(inst.lastFrame() ?? '').toContain('Available providers:');

    // Sending a real message supersedes the /models notice, just like /help — it no longer
    // crowds the live region below the new message.
    await type(inst, 'hello');
    await wait(300);
    const frame = inst.lastFrame() ?? '';
    // The /models notice is gone; only the settled message remains in the live region.
    expect(frame).not.toContain('Available providers:');
    expect(frame).toContain('❯ hello');
    inst.unmount();
    engine.close();
  });

  it('the add-model flow replaces its own prompts step by step', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/models grok');
    let frame = inst.lastFrame() ?? '';
    expect(frame).toContain('Enter the model name for Grok');

    await type(inst, 'grok-4'); // grok has no key in the test config -> key prompt replaces model prompt
    frame = inst.lastFrame() ?? '';
    expect(frame).toContain('Enter the API key for Grok');
    expect(frame).not.toContain('Enter the model name for Grok');
    inst.unmount();
    engine.close();
  });
});
