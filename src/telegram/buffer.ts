import type { EngineEvent } from '../events.js';

/** Accumulated state for one streaming turn (assistant answer + tool markers). */
export interface BufferState {
  answer: string;
  markers: string[];
  pendingTool?: string;
  error?: string;
  done: boolean;
  startedAt: number;
}

export function createBuffer(): BufferState {
  return { answer: '', markers: [], done: false, startedAt: Date.now() };
}

/**
 * Fold a single engine event into the buffer, returning a new state.
 * Thinking deltas are intentionally ignored (answer + tool markers only).
 */
export function applyEvent(state: BufferState, event: EngineEvent): BufferState {
  switch (event.type) {
    case 'text-delta':
      return { ...state, answer: state.answer + event.text };
    case 'thinking-delta':
      return state;
    case 'tool-start':
      return { ...state, pendingTool: `⚙ ${event.name} …` };
    case 'tool-result':
      return {
        ...state,
        markers: [...state.markers, event.result.isError ? `✗ ${event.name} failed` : `✓ ${event.name} (${event.durationMs}ms)`],
        pendingTool: undefined,
      };
    case 'error':
      return { ...state, error: event.message };
    case 'turn-end':
      return { ...state, done: true };
    case 'interrupted':
      return { ...state, done: true, error: 'interrupted' };
    case 'turn-start':
      return { ...state, answer: '', markers: [], pendingTool: undefined, error: undefined, done: false };
    default:
      return state;
  }
}

/** Render the buffer to bubble text, truncating past maxChars with a trailing ellipsis. */
export function render(state: BufferState, opts: { maxChars: number }): string {
  const sections: string[] = [];
  if (state.answer) sections.push(state.answer);
  if (state.markers.length) sections.push(state.markers.join('\n'));
  if (state.pendingTool) sections.push(state.pendingTool);
  if (state.error) sections.push(`\n⚠ ${state.error}`);
  if (state.done && state.error) sections.push(`\n\n— 失败 · 用时 ${elapsedSec(state.startedAt)}s`);
  else if (state.done) sections.push(`\n\n— 完成 · 用时 ${elapsedSec(state.startedAt)}s`);

  let text = sections.join('\n');
  if (text.length > opts.maxChars) {
    text = text.slice(0, Math.max(0, opts.maxChars - 1)) + '…';
  }
  return text;
}

function elapsedSec(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

/**
 * Split a long string into chunks of at most maxChars, breaking greedily at the last
 * newline before the limit so lines stay intact.
 */
export function splitRemainder(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text.length ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const cut = window.lastIndexOf('\n');
    const splitAt = cut > maxChars / 2 ? cut : maxChars;
    chunks.push(rest.slice(0, splitAt).trimEnd());
    rest = rest.slice(splitAt).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
