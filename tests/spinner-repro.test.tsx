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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe('full TUI spinner during tool run', () => {
  it('spinner animates while a slow tool is executing', async () => {
    // Two-phase provider modelling the real agentic loop: call #1 asks for a slow tool
    // (run_terminal_cmd 'sleep 2'), call #2 (after the tool finished) returns the final text.
    let call = 0;
    const provider: LLMProvider = {
      id: 'deepseek',
      model: 'deepseek-chat',
      modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
      async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
        if (call++ === 0) {
          yield { type: 'text-delta', text: 'Calling tool' };
          yield {
            type: 'done',
            response: {
              message: { role: 'assistant', content: [{ type: 'text', text: 'Calling tool' }, { type: 'tool_use', id: 'c1', name: 'run_terminal_cmd', input: { command: 'sleep 2' } }] },
              usage: { inputTokens: 10, outputTokens: 5 },
              stopReason: 'tool_use',
            },
          };
          return;
        }
        yield { type: 'text-delta', text: 'Tool done' };
        yield { type: 'done', response: { message: { role: 'assistant', content: 'Tool done' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' } };
      },
      async complete() {
        throw new Error('not used');
      },
    };

    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = provider as never;
    // Auto-allow the terminal tool so no approval dialog pauses busy
    engine.gate.remember({ callId: 'x', toolName: 'run_terminal_cmd', command: 'sleep 2', risk: 'low' as never, action: 'allow-always' });
    await engine.init();
    const { lastFrame, unmount } = render(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }));

    const turn = engine.runTurn('run tool');
    await sleep(200);
    const frames: string[] = [];
    for (let i = 0; i < 6; i++) {
      await sleep(130);
      frames.push(lastFrame() ?? '');
    }
    await turn;
    unmount();
    engine.close();

    // The spinner glyph animates on the tool card (⠸ Bash (sleep 2)) and/or the status bar
    // (⠋ Running). Both draw from the same SPINNER_FRAMES set.
    const glyphs = frames.map((f) => {
      const m = f.match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(?:Bash \(|Running)/);
      return m ? m[1] : null;
    });
    console.log('TOOL GLYPHS:', JSON.stringify(glyphs));
    console.log('TOOL FRAME[1]:', JSON.stringify(frames[1]));
    const unique = new Set(glyphs.filter(Boolean));
    expect(unique.size).toBeGreaterThan(1);
  });
});
