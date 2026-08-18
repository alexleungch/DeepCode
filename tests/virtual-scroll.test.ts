import { describe, it, expect } from 'vitest';
import { estimateMessageRows, messageWindow, messageIndexWindow, bottomStart, estimateTotalRows } from '../src/ui/virtual-scroll.js';
import type { MessageView, ToolCallView } from '../src/ui/state.js';

const user = (text: string, id = 1): MessageView => ({ id, role: 'user', text, thinking: '', toolCalls: [], streaming: false, source: 'user' });
const assistant = (text: string, id = 2, toolCalls: ToolCallView[] = [], streaming = false): MessageView => ({
  id,
  role: 'assistant',
  text,
  thinking: '',
  toolCalls,
  streaming,
  source: 'assistant',
});

describe('estimateMessageRows', () => {
  it('single-line user message: 1 row + margin', () => {
    expect(estimateMessageRows(user('hi'), 80, {})).toBe(2);
  });

  it('long CJK user text wraps by display width (CJK = 2 columns)', () => {
    // 60 CJK chars = 120 display columns at width 40 → content width 38 → ceil(120/38)=4 rows + margin
    expect(estimateMessageRows(user('你'.repeat(60)), 40, {})).toBe(5);
  });

  it('assistant markdown lines each count as (wrapped) rows', () => {
    // Two markdown lines: 'short' (1 row) + 100 ASCII chars at content width 38 → ceil(100/38)=3 rows,
    // plus the per-message margin row.
    const m = assistant('short\n' + 'a'.repeat(100));
    expect(estimateMessageRows(m, 40, {})).toBe(1 + Math.ceil(100 / 38) + 1);
  });

  it('tool cards contribute bounded rows (header + progress tail + capped result)', () => {
    const tc: ToolCallView = {
      callId: 'c1',
      name: 'run_terminal_cmd',
      input: {},
      inputJson: '',
      progress: 'line1\nline2\nline3\nline4', // tail shows at most 3
      status: 'running',
    };
    const m = assistant('', 2, [tc], true);
    expect(estimateMessageRows(m, 80, {})).toBe(1 + 1 + 3 + 1); // text(1) + progress(3) + margin
  });
});

describe('messageWindow', () => {
  it('returns everything when the whole list fits the budget', () => {
    const msgs = [assistant('one', 1), assistant('two', 2)];
    expect(messageWindow(msgs, 80, 100, {})).toEqual({ start: 0, end: 2 });
  });

  it('trims the OLDEST messages when the list overflows the budget', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => assistant(`msg ${i}`, i));
    const w = messageWindow(msgs, 80, 10, {});
    expect(w.end).toBe(50);
    expect(w.start).toBeGreaterThan(0);
    expect(w.end - w.start).toBeLessThan(50);
  });

  it('always includes the newest message even with a tiny budget', () => {
    const msgs = [assistant('old', 1), assistant('new', 2)];
    expect(messageWindow(msgs, 80, 1, {}).start).toBe(1);
  });

  it('empty list yields an empty window', () => {
    expect(messageWindow([], 80, 10, {})).toEqual({ start: 0, end: 0 });
  });
});

describe('messageIndexWindow (position-based scroll)', () => {
  // 10 short messages, each 2 estimated rows (1 content + 1 margin).
  const msgs: MessageView[] = Array.from({ length: 10 }, (_, i) => user(`msg ${i}`, i));

  it('at the top (desiredStart 0) shows the OLDEST messages, not the newest', () => {
    const w = messageIndexWindow(msgs, 80, 0, 4, {});
    expect(w.start).toBe(0);
    expect(w.atBottom).toBe(false);
  });

  it('bottomStart positions the window on the newest messages and is marked atBottom', () => {
    const bs = bottomStart(msgs, 80, 4, {});
    const w = messageIndexWindow(msgs, 80, bs, 4, {});
    expect(w.atBottom).toBe(true);
    expect(w.end).toBe(msgs.length);
    // The bottom view is exactly the end-anchored window's start.
    expect(bs).toBe(messageWindow(msgs, 80, 4, {}).start);
  });

  it('a middle position shows a window that does NOT reach the newest (so PageDown can advance)', () => {
    const w = messageIndexWindow(msgs, 80, 5, 4, {});
    expect(w.start).toBe(5);
    expect(w.atBottom).toBe(false);
    expect(w.end).toBeGreaterThan(w.start);
    expect(w.end).toBeLessThan(msgs.length);
  });

  it('clamps desiredStart into [0, N-1] and handles an empty list', () => {
    expect(messageIndexWindow([], 80, 0, 4, {})).toEqual({ start: 0, end: 0, atBottom: true });
    const w = messageIndexWindow(msgs, 80, 999, 4, {});
    expect(w.atBottom).toBe(true); // clamped to the bottom
  });
});

describe('estimateTotalRows', () => {
  it('sums per-message row estimates', () => {
    const msgs = [user('hi', 1), user('hi', 2), user('hi', 3)];
    expect(estimateTotalRows(msgs, 80, {})).toBe(6); // 3 × 2 rows
  });
});
