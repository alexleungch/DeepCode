import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent, EngineEventSink } from '../events.js';
import { TRACE_SCHEMA_VERSION, type TraceEventLine, type TraceLine, type TraceMetaLine } from './types.js';

/**
 * Trace recorder: subscribes to the engine event stream (`engine.onEvent(recorder.onEvent)`)
 * and appends every event to `<sessionId>.trace.jsonl`.
 *
 * A trace is the exact event sequence the TUI reducer consumes, so it can be replayed
 * deterministically (no IO, no LLM) for regression tests and golden-state comparisons —
 * see src/trace/replay.ts and src/trace/assert.ts. Unlike SessionStore (which only keeps
 * coarse message/usage/todo lines), a trace preserves thinking deltas, tool input/progress
 * deltas and approval flows, i.e. everything needed to rebuild the UI state.
 */
export class TraceRecorder {
  readonly file: string;
  private seq = 0;
  private turn = 0;
  private startTs = Date.now();
  private opened = false;

  constructor(
    private dir: string,
    private sessionId: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${sessionId}.trace.jsonl`);
  }

  /** EngineEventSink entry point: pass as `engine.onEvent(recorder.onEvent)` */
  readonly onEvent: EngineEventSink = (event) => {
    if (!this.opened) this.open(event);
    if (event.type === 'turn-start') this.turn = event.turn;
    const line: TraceEventLine = {
      seq: ++this.seq,
      turn: this.turn,
      ts: (Date.now() - this.startTs) / 1000,
      event,
    };
    this.append(line);
  };

  /** Lazy meta line: prefers the session-start event, falls back to the constructor sessionId */
  private open(first: EngineEvent): void {
    this.opened = true;
    const meta: TraceMetaLine = {
      v: TRACE_SCHEMA_VERSION,
      sessionId: first.type === 'session-start' ? first.sessionId : this.sessionId,
      provider: first.type === 'session-start' ? first.provider : '',
      model: first.type === 'session-start' ? first.model : '',
      workspace: first.type === 'session-start' ? first.workspace : '',
      startedAt: this.startTs,
    };
    this.append(meta);
  }

  /** Append-only write (JSONL). The previous tmp+rename rewrite became O(file size) per event as
   *  the trace grew (with --trace every engine event lands here), allocating a full-file string on
   *  each append. load()/replay already tolerate torn lines, so a plain append is safe. */
  private append(line: TraceLine): void {
    appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8');
  }
}
