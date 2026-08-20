import type { EngineEvent } from '../events.js';

/**
 * Streaming events (text-delta / thinking-delta / tool-progress / tool-input-delta) can arrive much
 * faster than React renders — every event used to trigger its own setState, so a long reply (or a
 * long streamed tool-argument JSON) re-rendered the whole TUI once per token. EventBatcher
 * coalesces those high-frequency events into ONE batch per frame (EVENT_BATCH_MS, trailing-edge)
 * while applying control events immediately.
 *
 * Order is preserved: when a control event arrives, buffered deltas are flushed FIRST, then the
 * control event is applied. This matters because the state reducer appends deltas to the last
 * STREAMING assistant message — flushing a delta after its `message`/`turn-end` would corrupt it
 * into a spurious new message.
 */
export const EVENT_BATCH_MS = 16;

/** Event types that are safe to delay by one frame (they only accumulate text). */
const THROTTLED_EVENTS = new Set<EngineEvent['type']>(['text-delta', 'thinking-delta', 'tool-progress', 'tool-input-delta']);

export class EventBatcher {
  private pending: EngineEvent[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly apply: (events: EngineEvent[]) => void) {}

  /** Queue an event; throttled events batch into the next frame, control events apply now. */
  push(event: EngineEvent): void {
    if (!THROTTLED_EVENTS.has(event.type)) {
      this.flush();
      this.apply([event]);
      return;
    }
    this.pending.push(event);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), EVENT_BATCH_MS);
    }
  }

  /** Apply all buffered events in a single batch (also drains the trailing-edge timer). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.apply(batch);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
