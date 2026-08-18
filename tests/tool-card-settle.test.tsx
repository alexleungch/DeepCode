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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Deterministic slow real tool: use cmd's `ping -n 2 127.0.0.1 > nul` (~1s, cross-shell enough for win32 CI). */
const slowCommand = () => (process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > nul' : 'sleep 1');

/** Provider that asks to run a slow terminal command, then (after a beat) returns a final text answer. */
function slowToolProvider(): { provider: LLMProvider; toolStarted: () => boolean } {
  let call = 0;
  let started = false;
  const provider: LLMProvider = {
    id: 'deepseek',
    model: 'deepseek-chat',
    modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
    async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
      if (call++ === 0) {
        started = true;
        yield { type: 'text-delta', text: 'Running slow tool' };
        yield {
          type: 'done',
          response: {
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Running slow tool' },
                { type: 'tool_use', id: 'c1', name: 'run_terminal_cmd', input: { command: slowCommand() } },
              ],
            },
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          },
        };
        return;
      }
      yield { type: 'text-delta', text: 'Tool finished' };
      yield {
        type: 'done',
        response: { message: { role: 'assistant', content: 'Tool finished' }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' },
      };
    },
    async complete() {
      throw new Error('not used');
    },
  };
  return { provider, toolStarted: () => started };
}

describe('P0#1 tool card settles after executor runs (no stuck streaming)', () => {
  it('a tool card reaches a terminal icon (✓/✗) after executor result, not "…" forever', async () => {
    const { provider } = slowToolProvider();
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = provider as never;
    // auto-allow the terminal tool so no approval dialog pauses on busy
    engine.gate.remember({ callId: 'x', toolName: 'run_terminal_cmd', command: slowCommand(), risk: 'low' as never, action: 'allow-always' });
    await engine.init();
    const inst = render(React.createElement(DeepcodeTUI, { engine, onExit: () => undefined }));

    const turn = engine.runTurn('run tool');
    // Give the stream phase time to create the tool card, then wait for the whole turn
    // (executor runs a real ~1s command; this is the regression window where the old code
    // left the card spinning after a fast-provider turn-end).
    await turn;
    await wait(300);

    const frame = inst.lastFrame() ?? '';
    // The card must have settled — either done (✓) or error (✗) icon, never the streaming "…" glyph
    expect(frame).toMatch(/[✓✗]\s+Bash \(/);
    // ...and the tool's own result line must be present (proves tool-result was applied to the card)
    expect(frame).toContain('⎿');

    inst.unmount();
    engine.close();
  });
});