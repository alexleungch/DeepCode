import { describe, it, expect } from 'vitest';
import type { EngineEvent } from '../../src/events.js';
import { createBuffer, applyEvent, render, splitRemainder } from '../../src/telegram/buffer.js';

function ev(partial: Omit<EngineEvent, 'type'> & { type: EngineEvent['type'] }): EngineEvent {
  return partial as EngineEvent;
}

describe('applyEvent', () => {
  it('appends text-delta to the answer', () => {
    const s = applyEvent(createBuffer(), ev({ type: 'text-delta', text: 'Hello ' }));
    expect(applyEvent(s, ev({ type: 'text-delta', text: 'world' })).answer).toBe('Hello world');
  });

  it('ignores thinking-delta', () => {
    const s = applyEvent(createBuffer(), ev({ type: 'thinking-delta', text: 'hmm' }));
    expect(s.answer).toBe('');
  });

  it('tracks a pending tool on tool-start and records a marker on tool-result', () => {
    let s = applyEvent(createBuffer(), ev({ type: 'tool-start', callId: '1', name: 'bash', input: {} }));
    expect(s.pendingTool).toBe('⚙ bash …');
    s = applyEvent(s, ev({ type: 'tool-result', callId: '1', name: 'bash', result: { content: 'ok' }, durationMs: 12 }));
    expect(s.markers).toEqual(['✓ bash (12ms)']);
    expect(s.pendingTool).toBeUndefined();
  });

  it('marks a failed tool result with an x marker', () => {
    const s = applyEvent(createBuffer(), ev({ type: 'tool-result', callId: '1', name: 'bash', result: { content: 'bad', isError: true }, durationMs: 5 }));
    expect(s.markers).toEqual(['✗ bash failed']);
  });

  it('captures error events and sets done on turn-end / interrupted', () => {
    const e = applyEvent(createBuffer(), ev({ type: 'error', message: 'boom' }));
    expect(e.error).toBe('boom');
    expect(applyEvent(createBuffer(), ev({ type: 'turn-end', turn: 1, stopReason: 'end_turn' })).done).toBe(true);
    const i = applyEvent(createBuffer(), ev({ type: 'interrupted' }));
    expect(i.done).toBe(true);
    expect(i.error).toBe('interrupted');
  });
});

describe('render', () => {
  it('renders answer + markers + done footer', () => {
    let s = createBuffer();
    s = applyEvent(s, ev({ type: 'text-delta', text: 'answer' }));
    s = applyEvent(s, ev({ type: 'tool-result', callId: '1', name: 'read', result: { content: '' }, durationMs: 3 }));
    s = applyEvent(s, ev({ type: 'turn-end', turn: 1, stopReason: 'end_turn' }));
    const text = render(s, { maxChars: 1000 });
    expect(text).toContain('answer');
    expect(text).toContain('✓ read (3ms)');
    expect(text).toContain('— 完成');
  });

  it('truncates past maxChars with a trailing ellipsis', () => {
    let s = createBuffer();
    s = applyEvent(s, ev({ type: 'text-delta', text: 'x'.repeat(100) }));
    const text = render(s, { maxChars: 20 });
    expect(text.length).toBe(20);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('splitRemainder', () => {
  it('returns the whole text when within limits', () => {
    expect(splitRemainder('abc', 1000)).toEqual(['abc']);
    expect(splitRemainder('', 1000)).toEqual([]);
  });

  it('splits on newline boundaries', () => {
    const long = `${'a'.repeat(10)}\n${'b'.repeat(10)}\n${'c'.repeat(10)}`;
    const chunks = splitRemainder(long, 12);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 12)).toBe(true);
    // every non-newline character is preserved across the chunks
    expect(chunks.join('').replace(/\n/g, '')).toBe('a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(10));
  });
});
