import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, type Instance } from 'ink-testing-library';
import React from 'react';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
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

describe('TUI /export', () => {
  it('writes the conversation to a file and shows a notice', async () => {
    const { engine, inst } = await setup();
    await type(inst, 'hello');
    await type(inst, '/export');

    const exportsDir = join(ws, '.deepcode', 'exports');
    expect(existsSync(exportsDir)).toBe(true);
    const files = readdirSync(exportsDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = readFileSync(join(exportsDir, files[0]!), 'utf8');
    expect(content).toContain('User');
    expect(content).toContain('hello');
    expect(inst.lastFrame() ?? '').toContain('Conversation exported to');

    inst.unmount();
    engine.close();
  });

  it('honors a custom relative path argument', async () => {
    const { engine, inst } = await setup();
    await type(inst, 'hello');
    await type(inst, '/export my-convo.md');

    const file = join(ws, 'my-convo.md');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('hello');

    inst.unmount();
    engine.close();
  });

  it('reports nothing to export for an empty conversation', async () => {
    const { engine, inst } = await setup();
    await type(inst, '/export');
    expect(inst.lastFrame() ?? '').toContain('Nothing to export.');
    inst.unmount();
    engine.close();
  });
});
