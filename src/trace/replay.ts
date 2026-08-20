import { readFileSync } from 'node:fs';
import type { EngineEvent } from '../events.js';
import { emptyState, reduceState, type TUIState } from '../ui/state.js';
import type { TraceEventLine, TraceLine, TraceMetaLine, TraceRecord } from './types.js';

/**
 * Trace replay: load a trace JSONL file and feed its events back through the pure TUI state
 * reducer. No IO, no LLM — a few hundred events replay in milliseconds, which makes trace
 * regression tests suitable for CI.
 */

/** Load a trace JSONL file into a TraceRecord (tolerates a torn line) */
export function loadTrace(file: string): TraceRecord {
  let meta: TraceMetaLine | undefined;
  const events: TraceEventLine[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let line: TraceLine;
    try {
      line = JSON.parse(raw) as TraceLine;
    } catch {
      continue;
    }
    if ('event' in line) events.push(line);
    else meta = line;
  }
  if (!meta) throw new Error(`Trace file has no meta line: ${file}`);
  return { meta, events };
}

/** The raw engine events of a trace, in order */
export function traceEvents(record: TraceRecord): EngineEvent[] {
  return record.events.map((l) => l.event);
}

/** Replay a trace through the reducer → deterministic final UI state */
export function replayState(record: TraceRecord): TUIState {
  let state = emptyState();
  for (const { event } of record.events) state = reduceState(state, event);
  return state;
}

/** Convenience: load + replay from a file path */
export function replayStateFromFile(file: string): TUIState {
  return replayState(loadTrace(file));
}
