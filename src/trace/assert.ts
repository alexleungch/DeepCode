import { loadTrace, replayState } from './replay.js';
import type { TraceRecord } from './types.js';
import type { TUIState } from '../ui/state.js';

/**
 * Trace-level assertion DSL. Traces are the ground truth of what the engine emitted, so
 * every check here runs offline against the recorded JSONL (or an in-memory TraceRecord):
 *
 *   expectTrace(traceFile)
 *     .turns(2)
 *     .toolCalled('read_file', { path: 'a.ts' })
 *     .settled()
 *     .noErrors()
 *     .stateSnapshot();
 */

function fail(msg: string): never {
  throw new Error(msg);
}

/** Partial deep match: every key in `expected` must equal the corresponding key in `actual` */
function partialMatch(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== 'object' || actual === null) return false;
  for (const [k, v] of Object.entries(expected)) {
    const a = (actual as Record<string, unknown>)[k];
    if (JSON.stringify(a) !== JSON.stringify(v)) return false;
  }
  return true;
}

export interface TraceAssertions {
  /** The trace ran exactly n turns (one `turn-start` per turn) */
  turns(n: number): TraceAssertions;
  /** A tool with this name was invoked (optional partial input match) */
  toolCalled(name: string, input?: Record<string, unknown>): TraceAssertions;
  /** No streaming message left unsettled and engine not busy at the end — the spinner-stuck invariant */
  settled(): TraceAssertions;
  /** No `error` events were emitted */
  noErrors(): TraceAssertions;
  /** Replayed final UI state, for custom assertions */
  finalState(): TUIState;
  /** Deterministic JSON snapshot of the final state (view ids stripped) for golden-file comparison */
  stateSnapshot(): string;
}

export function expectTrace(trace: string | TraceRecord): TraceAssertions {
  const record: TraceRecord = typeof trace === 'string' ? loadTrace(trace) : trace;

  const self: TraceAssertions = {
    turns(n: number) {
      const turns = new Set(
        record.events
          .filter((l): l is (typeof l & { event: { type: 'turn-start'; turn: number } }) => l.event.type === 'turn-start')
          .map((l) => l.event.turn),
      );
      if (turns.size !== n) fail(`expected ${n} turn(s), got ${turns.size}`);
      return self;
    },

    toolCalled(name: string, input?: Record<string, unknown>) {
      const hit = record.events.some(
        (l) =>
          l.event.type === 'tool-start' &&
          l.event.name === name &&
          (!input || partialMatch(l.event.input, input)),
      );
      if (!hit) fail(`expected tool call "${name}"${input ? ` with input ${JSON.stringify(input)}` : ''} in trace, not found`);
      return self;
    },

    settled() {
      const state = replayState(record);
      const stuck = state.messages.filter((m) => m.streaming).map((m) => m.id);
      if (state.busy || stuck.length > 0) {
        fail(`expected no unsettled streaming messages at end of trace; busy=${state.busy}, streaming message ids=${JSON.stringify(stuck)}`);
      }
      return self;
    },

    noErrors() {
      const errs = record.events.filter((l) => l.event.type === 'error');
      if (errs.length > 0) {
        fail(`expected no error events, got ${errs.length}: ${errs.map((l) => (l.event as { message: string }).message).join('; ')}`);
      }
      return self;
    },

    finalState() {
      return replayState(record);
    },

    stateSnapshot() {
      const state = replayState(record);
      const norm = {
        ...state,
        messages: state.messages.map(({ id: _id, ...rest }) => rest),
        notices: state.notices.map(({ id: _id, ...rest }) => rest),
      };
      return JSON.stringify(norm, null, 2);
    },
  };
  return self;
}
