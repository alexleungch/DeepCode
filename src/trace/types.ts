import type { EngineEvent } from '../events.js';
import type { ProviderId } from '../config/types.js';

/** Schema version of the trace JSONL format (bump on incompatible changes) */
export const TRACE_SCHEMA_VERSION = 1;

/** First line of a trace file: schema version + volatile fields (normalized away in comparisons) */
export interface TraceMetaLine {
  v: number;
  sessionId: string;
  provider: ProviderId | '';
  model: string;
  workspace: string;
  startedAt: number;
}

/** One event line: seq is monotonic, turn is the active turn, ts is seconds since session start */
export interface TraceEventLine {
  seq: number;
  turn: number;
  ts: number;
  event: EngineEvent;
}

export type TraceLine = TraceMetaLine | TraceEventLine;

/** A fully loaded trace */
export interface TraceRecord {
  meta: TraceMetaLine;
  events: TraceEventLine[];
}
