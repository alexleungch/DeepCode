import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceRecorder } from '../src/trace/recorder.js';
import { loadTrace, replayState, replayStateFromFile, traceEvents } from '../src/trace/replay.js';
import { expectTrace } from '../src/trace/assert.js';
import type { EngineEvent } from '../src/events.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'traces');

describe('TraceRecorder', () => {
  it('round-trips events into JSONL and back (meta + events)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-rec-'));
    try {
      const rec = new TraceRecorder(dir, 'sess-1');
      const events: EngineEvent[] = [
        { type: 'session-start', sessionId: 'sess-1', provider: 'deepseek', model: 'deepseek-chat', workspace: '/ws', branch: null, resumed: false },
        { type: 'turn-start', turn: 1 },
        { type: 'text-delta', text: 'hi' },
        { type: 'turn-end', turn: 1, stopReason: 'end_turn' },
      ];
      for (const e of events) rec.onEvent(e);
      expect(existsSync(rec.file)).toBe(true);
      const record = loadTrace(rec.file);
      expect(record.meta).toMatchObject({ v: 1, sessionId: 'sess-1', provider: 'deepseek', model: 'deepseek-chat', workspace: '/ws' });
      expect(traceEvents(record)).toEqual(events);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tracks turn from turn-start and keeps seq monotonic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-rec-'));
    try {
      const rec = new TraceRecorder(dir, 'sess-2');
      rec.onEvent({ type: 'turn-start', turn: 1 });
      rec.onEvent({ type: 'text-delta', text: 'a' });
      rec.onEvent({ type: 'turn-start', turn: 2 });
      rec.onEvent({ type: 'text-delta', text: 'b' });
      const record = loadTrace(rec.file);
      expect(record.events.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
      expect(record.events.map((l) => l.turn)).toEqual([1, 1, 2, 2]);
      // meta falls back to the constructor sessionId when session-start is not the first event
      expect(record.meta.sessionId).toBe('sess-2');
      expect(record.events[0]!.ts).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('expectTrace golden fixtures (spinner-stuck regression)', () => {
  const bug = join(fixtures, 'spinner-stuck-bug.trace.jsonl');
  const fixed = join(fixtures, 'spinner-settled-fixed.trace.jsonl');

  it('bug fixture: thinking-only trace leaves the message unsettled, so settled() fails', () => {
    expect(() => expectTrace(bug).settled()).toThrow(/streaming/);
    // the invariant violation is visible in the replayed state: message still streaming
    const state = replayStateFromFile(bug);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.streaming).toBe(true);
  });

  it('fixed fixture: a message event settles the streaming message, so settled() passes', () => {
    expect(() => expectTrace(fixed).settled()).not.toThrow();
  });

  it('fixed fixture: turns / toolCalled / noErrors / finalState assertions', () => {
    expectTrace(fixed)
      .turns(1)
      .toolCalled('read_file', { path: 'a.ts' })
      .noErrors();
    const state = expectTrace(fixed).finalState();
    expect(state.messages[0]!.text).toBe('The file contains a constant.');
    expect(state.turnCount).toBe(1);
  });

  it('toolCalled with no input matches any input', () => {
    expectTrace(fixed).toolCalled('read_file');
    expect(() => expectTrace(fixed).toolCalled('write_file')).toThrow(/write_file/);
  });

  it('stateSnapshot is deterministic and strips view ids', () => {
    const a = expectTrace(fixed).stateSnapshot();
    const b = expectTrace(fixed).stateSnapshot();
    expect(a).toBe(b);
    expect(a).not.toContain('"id":');
    expect(a).not.toContain('"seq":');
  });
});
