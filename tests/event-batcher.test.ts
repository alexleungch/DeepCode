import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBatcher, EVENT_BATCH_MS } from '../src/ui/event-batcher.js';
import type { EngineEvent } from '../src/events.js';

const delta = (text: string): EngineEvent => ({ type: 'text-delta', text });
const texts = (batch: EngineEvent[]) => batch.map((e) => (e as { text: string }).text);

describe('EventBatcher (16ms streaming batching)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces high-frequency deltas into a single batch, preserving order', () => {
    const applied: EngineEvent[][] = [];
    const batcher = new EventBatcher((events) => applied.push(events));
    for (let i = 0; i < 100; i++) batcher.push(delta(`t${i}`));
    expect(applied).toHaveLength(0); // nothing applied before the frame elapses

    vi.advanceTimersByTime(EVENT_BATCH_MS + 1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(100);
    expect(texts(applied[0]!)).toEqual(Array.from({ length: 100 }, (_, i) => `t${i}`));
    batcher.dispose();
  });

  it('keeps batching while deltas keep arriving (trailing-edge timer resets)', () => {
    const applied: EngineEvent[][] = [];
    const batcher = new EventBatcher((events) => applied.push(events));
    batcher.push(delta('a'));
    vi.advanceTimersByTime(EVENT_BATCH_MS - 1);
    batcher.push(delta('b')); // arrival before the frame restarts the window
    vi.advanceTimersByTime(EVENT_BATCH_MS);
    expect(applied).toHaveLength(1);
    expect(texts(applied[0]!)).toEqual(['a', 'b']);
    batcher.dispose();
  });

  it('applies a control event immediately, flushing buffered deltas FIRST (order preserved)', () => {
    const applied: EngineEvent[][] = [];
    const batcher = new EventBatcher((events) => applied.push(events));
    batcher.push(delta('a'));
    batcher.push(delta('b'));
    batcher.push({ type: 'turn-end', turn: 1, stopReason: 'end_turn' });

    expect(applied).toHaveLength(2);
    expect(texts(applied[0]!)).toEqual(['a', 'b']); // deltas land before the control event
    expect(applied[1]![0]!.type).toBe('turn-end');
    batcher.dispose();
  });

  it('flush() drains the remaining buffer (final token is never dropped)', () => {
    const applied: EngineEvent[][] = [];
    const batcher = new EventBatcher((events) => applied.push(events));
    batcher.push(delta('x'));
    batcher.flush();
    expect(applied).toHaveLength(1);
    expect(texts(applied[0]!)).toEqual(['x']);
    batcher.dispose();
  });

  it('dispose() cancels the timer without applying', () => {
    const applied: EngineEvent[][] = [];
    const batcher = new EventBatcher((events) => applied.push(events));
    batcher.push(delta('x'));
    batcher.dispose();
    vi.advanceTimersByTime(EVENT_BATCH_MS * 10);
    expect(applied).toHaveLength(0);
  });
});
