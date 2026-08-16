import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { PromptInput } from '../src/ui/components/PromptInput.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function typeChar(inst: ReturnType<typeof render>, ch: string) {
  inst.stdin.write(ch);
  await wait(10);
}

describe('PromptInput multi-line editing', () => {
  it('wraps long input to multiple lines instead of truncating it', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, { disabled: false, width: 40, onSubmit: (t) => submitted.push(t) }),
    );
    // 40 columns total -> textWidth = 36; 50 'x' chars must wrap to 2 lines, all visible.
    const text = 'x'.repeat(50);
    for (const ch of text) {
      await typeChar(inst, ch);
    }
    const frame = inst.lastFrame() ?? '';
    // The full text is present (no truncation) and spans more than one line.
    expect(frame).toContain(text);
    const lines = frame.split('\n');
    expect(lines.filter((l) => l.includes('x')).length).toBeGreaterThan(1);
    // The wrapped continuation line is indented under the "❯ " prefix.
    expect(frame).toContain('  xxxx');
    inst.unmount();
  });

  it('inserts at the cursor after moving left, so earlier text can be fixed', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, { disabled: false, width: 100, onSubmit: (t) => submitted.push(t) }),
    );
    for (const ch of 'abc') await typeChar(inst, ch);
    // ← ← (move to index 1), type 'X' -> "aXbc"
    inst.stdin.write('\x1b[D');
    await wait(10);
    inst.stdin.write('\x1b[D');
    await wait(10);
    await typeChar(inst, 'X');
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['aXbc']);
    inst.unmount();
  });

  it('backspace removes the char before the cursor (not just the end)', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, { disabled: false, width: 100, onSubmit: (t) => submitted.push(t) }),
    );
    for (const ch of 'abcd') await typeChar(inst, ch);
    // ← then backspace (\x7f) -> delete 'c' -> "abd"
    inst.stdin.write('\x1b[D');
    await wait(10);
    inst.stdin.write('\x7f');
    await wait(10);
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['abd']);
    inst.unmount();
  });

  it('Ctrl+A / Ctrl+E jump to start/end, Ctrl+U clears before the cursor', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, { disabled: false, width: 100, onSubmit: (t) => submitted.push(t) }),
    );
    for (const ch of 'hello') await typeChar(inst, ch);
    // Ctrl+A (0x01) then type '>' -> ">hello"
    inst.stdin.write('\x01');
    await wait(10);
    await typeChar(inst, '>');
    // Ctrl+E (0x05) then Ctrl+U (0x15) clears from cursor back to start -> ""
    inst.stdin.write('\x05');
    await wait(10);
    inst.stdin.write('\x15');
    await wait(10);
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['>hello']);
    inst.unmount();
  });

  it('shows a visible inverse-video cursor block', async () => {
    const inst = render(
      React.createElement(PromptInput, { disabled: false, width: 100, onSubmit: () => undefined }),
    );
    for (const ch of 'hi') await typeChar(inst, ch);
    const frame = inst.lastFrame() ?? '';
    // The cursor is rendered as an inverse block after the text.
    expect(frame).toContain('hi');
    expect(frame).toMatch(/\x1b\[7m/); // SGR inverse
    inst.unmount();
  });
});
