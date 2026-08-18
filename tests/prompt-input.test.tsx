import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { PromptInput } from '../src/ui/components/PromptInput.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Type a single char through the real stdin path (advances the cursor naturally).
async function typeChar(inst: ReturnType<typeof render>, ch: string) {
  inst.stdin.write(ch);
  await wait(10);
}

// Poll-for helper: pastes land as a single atomic chunk, so the frame may need a beat to settle.
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await wait(1);
  }
}

describe('PromptInput multi-line editing', () => {
  it('wraps long input to multiple lines instead of truncating it', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, {
        disabled: false,
        width: 40,
        onSubmit: (t) => submitted.push(t),
        testInput: (fn) => {
          // A real terminal delivers a paste as ONE chunk; type the whole line at once.
          fn('x'.repeat(50));
        },
      }),
    );
    await waitFor(() => (inst.lastFrame() ?? '').includes('xxxx'));
    const frame = inst.lastFrame() ?? '';
    // The full text is present (no truncation) and spans more than one line.
    expect(frame).toContain('xxx');
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
      React.createElement(PromptInput, {
        disabled: false,
        width: 100,
        onSubmit: (t) => submitted.push(t),
        testInput: (fn) => {
          // Prep the initial text atomically (paste semantics).
          fn('abcd');
        },
      }),
    );
    // ← then backspace (\x7f) -> delete 'c' -> "abd"
    inst.stdin.write('\x1b[D');
    await wait(10);
    inst.stdin.write('\x7f');
    await wait(20);
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['abd']);
    inst.unmount();
  });

  it('Ctrl+A / Ctrl+E jump to start/end, Ctrl+U clears before the cursor', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, {
        disabled: false,
        width: 100,
        onSubmit: (t) => submitted.push(t),
        testInput: (fn) => {
          // Simulate the full paste of 'hello' as one terminal chunk.
          fn('hello');
        },
      }),
    );
    await wait(20);
    // Ctrl+A (0x01) -> start, then type '>' prepends -> ">hello" (cursor after '>')
    inst.stdin.write('\x01');
    await wait(10);
    await typeChar(inst, '>');
    // Ctrl+E (0x05) -> jump to end (cursor 6)
    inst.stdin.write('\x05');
    await wait(10);
    // Move two steps left into "hello", then Ctrl+U (0x15) clears from the cursor back to
    // start, keeping only the tail after the cursor -> "lo".
    inst.stdin.write('\x1b[D');
    await wait(5);
    inst.stdin.write('\x1b[D');
    await wait(5);
    inst.stdin.write('\x15');
    await wait(20);
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['lo']);
    inst.unmount();
  });

  it('shows a visible inverse-video cursor block', async () => {
    const inst = render(
      React.createElement(PromptInput, {
        disabled: false,
        width: 100,
        onSubmit: () => undefined,
        testInput: (fn) => {
          // Type two chars as one atomic paste chunk.
          fn('hi');
        },
      }),
    );
    await waitFor(() => (inst.lastFrame() ?? '').includes('hi'));
    const frame = inst.lastFrame() ?? '';
    // The cursor is rendered as an inline block glyph (▌) immediately after the text. The
    // inverse-video styling is applied via <Text inverse> in PromptInput (code-verified);
    // ink-testing-library 4.x strips SGR from lastFrame(), so we assert the glyph's position.
    expect(frame).toContain('hi');
    expect(frame).toContain('hi▌');
    inst.unmount();
  });

  it('multi-line paste renders each pasted line as an editable row', async () => {
    const submitted: string[] = [];
    const multiline = 'line one\nline two\nline three';
    const inst = render(
      React.createElement(PromptInput, {
        disabled: false,
        width: 60,
        onSubmit: (t) => submitted.push(t),
        testInput: (fn) => {
          fn(multiline);
        },
      }),
    );
    await waitFor(() => (inst.lastFrame() ?? '').includes('line three'));
    const frame = inst.lastFrame() ?? '';
    // Every pasted line is visible as its own editable row (not truncated to one line).
    expect(frame).toContain('line one');
    expect(frame).toContain('line two');
    expect(frame).toContain('line three');
    // Submit preserves the newlines intact. (Settle one tick so the post-paste render has
    // re-subscribed useInput with the pasted value before Enter is processed.)
    await wait(30);
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual([multiline]);
    inst.unmount();
  });

  it('bracketed paste inserts the whole chunk without triggering submit on embedded \\n', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, { disabled: false, width: 80, onSubmit: (t) => submitted.push(t) }),
    );
    // Send the bracketed-paste sequence a real terminal emits when paste mode is on:
    //   \x1b[200~  <content with \n>  \x1b[201~
    // The embedded \n must NOT trigger Enter/submit — the whole chunk lands as one atomic
    // insert at the cursor.
    inst.stdin.write('\x1b[200~hello\nworld\x1b[201~');
    await wait(30);
    const frame = inst.lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');
    // No submit happened (the embedded \n did NOT trigger Enter).
    expect(submitted).toEqual([]);
    // Submit the pasted content explicitly to confirm it is intact.
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['hello\nworld']);
    inst.unmount();
  });

  it('Up/Down move the cursor between rows in multi-line input (so you can edit earlier text)', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, {
        disabled: false,
        width: 100,
        onSubmit: (t) => submitted.push(t),
        testInput: (fn) => {
          // Seed two lines; cursor lands at the end of the second line.
          fn('line one\nline two');
        },
      }),
    );
    await waitFor(() => (inst.lastFrame() ?? '').includes('line two'));
    // Up arrow -> move the cursor up to the end of 'line one'.
    inst.stdin.write('\x1b[A');
    await wait(20);
    // Type 'X' -> inserts at the new cursor position (end of 'line one').
    await typeChar(inst, 'X');
    await wait(20);
    // Submit -> the first line now ends with 'X'.
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['line oneX\nline two']);
    inst.unmount();
  });

  it('single-line Up/Down still cycles command history (no false multi-line motion)', async () => {
    const submitted: string[] = [];
    const inst = render(
      React.createElement(PromptInput, { disabled: false, width: 100, onSubmit: (t) => submitted.push(t) }),
    );
    // Submit one line so it enters history.
    for (const ch of 'first') await typeChar(inst, ch);
    inst.stdin.write('\r');
    await wait(20);
    // Type a new line, then Up should recall 'first' (history), not move a cursor.
    for (const ch of 'sec') await typeChar(inst, ch);
    inst.stdin.write('\x1b[A');
    await wait(20);
    inst.stdin.write('\r');
    await wait(30);
    expect(submitted).toEqual(['first', 'first']);
    inst.unmount();
  });

  it('keeps the cursor visible when the input exceeds maxLines (windowed scroll)', async () => {
    const inst = render(
      React.createElement(PromptInput, {
        disabled: false,
        width: 20, // textWidth = 16 -> 60 chars wrap to 4 rows
        maxLines: 2, // taller than the visible window
        onSubmit: () => undefined,
        testInput: (fn) => {
          // Seed more wrapped rows than maxLines so the box must scroll internally.
          // Use 'z' (absent from the placeholder text) so waitFor can't be satisfied by the
          // empty-state placeholder ("Type a message…").
          fn('z'.repeat(60));
        },
      }),
    );
    await waitFor(() => (inst.lastFrame() ?? '').includes('zzzz'));
    const frame = inst.lastFrame() ?? '';
    // Cursor block must be present even though the wrapped input is taller than maxLines.
    // (The pre-fix code pinned to the tail and compared the display index against the absolute
    // row, so the inverse-video cursor was never drawn once the input exceeded maxLines.)
    expect(frame).toContain('▌');
    // A "more content" hint appears because lines exist outside the visible window.
    expect(frame).toContain('更多内容在');
    inst.unmount();
  });
});