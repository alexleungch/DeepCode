/**
 * Trailing-edge throttle: coalesces rapid pushes into the latest value and guarantees
 * the last push after a quiet period is eventually run (a trailing timer is armed).
 * Errors from the underlying fn are swallowed so a failed edit can't break the stream.
 */
export class TrailingEdgeThrottle {
  private timer?: NodeJS.Timeout;
  private pending?: string;
  private lastRan = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly fn: (arg: string) => Promise<void>,
  ) {}

  /** Coalesce an update; fires immediately if the stream has been quiet >= interval, else schedules a trailing edge. */
  push(arg: string): void {
    this.pending = arg;
    const since = Date.now() - this.lastRan;
    if (since >= this.intervalMs) {
      this.runNow();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.runNow(), this.intervalMs - since);
    }
  }

  /** Guaranteed final call; awaits the last pending edit so the bubble settles. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending == null) return;
    const arg = this.pending;
    this.pending = undefined;
    this.lastRan = Date.now();
    await this.safeEdit(arg);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private runNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending == null) return;
    const arg = this.pending;
    this.pending = undefined;
    this.lastRan = Date.now();
    void this.safeEdit(arg);
  }

  private async safeEdit(arg: string): Promise<void> {
    try {
      await this.fn(arg);
    } catch {
      // swallow: "message is not modified", 429 rate limits, transient network errors
    }
  }
}
