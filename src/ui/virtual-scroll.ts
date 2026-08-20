import { charWidth } from './components/prompt-text.js';
import { buildMarkdownLines } from './components/MessageList.js';
import type { MessageView, ToolCallView } from './state.js';

/**
 * Row-budget windowing for the message viewport: Ink does not expose measured row heights, so we
 * ESTIMATE each message's rendered rows (markdown lines + thinking line + tool cards + wrap at the
 * terminal width) and only render the newest messages that fit the available rows (times an
 * overscan). Long histories then cost one frame of ~1.5× the viewport instead of the whole
 * conversation. Estimates are approximations — the overscan absorbs the error.
 */

/** Display width of a string in terminal columns (CJK / fullwidth / emoji count as 2). */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Approximate terminal rows a line of text wraps to at the given content width. */
function wrappedRows(text: string, contentWidth: number): number {
  return Math.max(1, Math.ceil(displayWidth(text) / Math.max(1, contentWidth)));
}

/**
 * Bounded row estimate for a tool card, mirroring ToolCard's layout:
 * header (1) + live progress tail (≤3) + result lines capped like ResultLines
 * (diff 30 / error 4 / normal 3, full when expanded) + the "… (N lines)" indicator.
 */
function toolCardRows(tc: ToolCallView, width: number, expanded: boolean): number {
  let rows = 1; // header
  const contentWidth = Math.max(1, width - 2);
  if (tc.progress && (tc.status === 'streaming' || tc.status === 'running')) {
    rows += Math.min(3, tc.progress.replace(/\n+$/, '').split('\n').length);
  }
  if (tc.result) {
    const lines = tc.result.diff ? tc.result.diff.split('\n') : tc.result.content.split('\n');
    const cap = expanded ? lines.length : tc.result.diff ? 30 : tc.result.isError ? 4 : 3;
    for (const l of lines.slice(0, cap)) rows += wrappedRows(l, contentWidth);
    if (!expanded && lines.length > cap) rows += 1; // truncated indicator
  }
  return rows;
}

export interface RowEstimateOpts {
  expandedCallId?: string | null;
  expandedThinkingId?: number | null;
}

/** Estimate the terminal rows a message occupies when rendered at `width` columns. */
export function estimateMessageRows(m: MessageView, width: number, opts: RowEstimateOpts): number {
  const contentWidth = Math.max(1, width - 2);
  let rows: number;
  if (m.role === 'user') {
    rows = wrappedRows(`❯ ${m.text}`, contentWidth);
  } else if (m.role === 'assistant') {
    rows = buildMarkdownLines(m).reduce((acc, l) => acc + wrappedRows(l.text, contentWidth), 0);
    // ThinkingLine renders while streaming (thinking, no text yet), when expanded, or when the
    // turn settled with thinking-only content (no text, no tool calls) — that thinking is the
    // answer and occupies one row.
    const thinkingShown =
      (m.streaming && !!m.thinking && !m.text) ||
      opts.expandedThinkingId === m.id ||
      (!m.text && !!m.thinking && m.toolCalls.length === 0);
    if (thinkingShown) rows += 1;
    for (const tc of m.toolCalls) rows += toolCardRows(tc, width, opts.expandedCallId === tc.callId);
  } else {
    rows = wrappedRows(m.text, contentWidth);
  }
  return Math.max(1, rows) + 1; // MessageItem wraps each message with marginBottom={1}
}

export interface ScrollWindow {
  start: number;
  end: number;
}

/**
 * Window into `messages` for the pinned viewport: walk from the newest message backwards,
 * accumulating estimated rows, and keep everything that fits within `budgetRows * overscanFactor`.
 * Always includes the newest message so the viewport is never empty. The window end is always
 * `messages.length` — the viewport is anchored at the bottom (newest), older messages are clipped.
 */
export function messageWindow(
  messages: MessageView[],
  width: number,
  budgetRows: number,
  opts: RowEstimateOpts,
  overscanFactor = 1.5,
): ScrollWindow {
  const limit = Math.max(1, Math.floor(budgetRows * overscanFactor));
  let rows = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = estimateMessageRows(messages[i]!, width, opts);
    // The newest message always renders; older ones are added only while the (overscanned) row
    // budget still has room — a single oversized message must not drag the whole history back in.
    if (rows + r > limit && i < messages.length - 1) break;
    rows += r;
    start = i;
  }
  return { start, end: messages.length };
}

/**
 * Total estimated rows for the whole conversation. Used to size/position the on-screen scrollbar
 * (how much of the conversation is visible vs. scrolled off).
 */
export function estimateTotalRows(messages: MessageView[], width: number, opts: RowEstimateOpts): number {
  let rows = 0;
  for (const m of messages) rows += estimateMessageRows(m, width, opts);
  return rows;
}

/**
 * Largest message index for which the window still reaches the newest message — i.e. the "bottom"
 * view (everything from here to the newest fits the viewport). Reuses the end-anchored windowing.
 */
export function bottomStart(messages: MessageView[], width: number, budgetRows: number, opts: RowEstimateOpts): number {
  if (messages.length === 0) return 0;
  return messageWindow(messages, width, budgetRows, opts).start;
}

export interface IndexWindow {
  /** First rendered message index. */
  start: number;
  /** Exclusive last rendered message index. */
  end: number;
  /** True when the window reaches the newest message (newest visible, anchored to bottom). */
  atBottom: boolean;
}

/**
 * Position-based window for the pinned viewport. Unlike the old end-anchored window (which always
 * pinned the newest and made `scrollOffset` a no-op for long conversations), this anchors the view
 * at `desiredStart` — the first message the user wants at the top — and renders forward until the
 * (overscanned) row budget is exhausted (always including `desiredStart`). When the window reaches
 * the newest message it is `atBottom` and the caller anchors it to the bottom; otherwise it is
 * anchored to the top so older content sits at the top and newer content (beyond the window) is
 * reachable via PageDown. This is what makes PageUp/PageDown actually scroll through history.
 */
export function messageIndexWindow(
  messages: MessageView[],
  width: number,
  desiredStart: number,
  budgetRows: number,
  opts: RowEstimateOpts,
  overscanFactor = 1.5,
): IndexWindow {
  const N = messages.length;
  if (N === 0) return { start: 0, end: 0, atBottom: true };
  const start = Math.max(0, Math.min(desiredStart, N - 1));
  const limit = Math.max(1, Math.floor(budgetRows * overscanFactor));
  let rows = estimateMessageRows(messages[start]!, width, opts);
  let end = start + 1;
  for (let i = start + 1; i < N; i++) {
    const r = estimateMessageRows(messages[i]!, width, opts);
    if (rows + r > limit) break;
    rows += r;
    end = i + 1;
  }
  return { start, end, atBottom: end >= N };
}
