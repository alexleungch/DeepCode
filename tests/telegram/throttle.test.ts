import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrailingEdgeThrottle } from '../../src/telegram/throttle.js';

describe('TrailingEdgeThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires the first push immediately, then coalesces rapid pushes into a trailing-edge run', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const t = new TrailingEdgeThrottle(1000, fn);
    t.push('a'); // first push: stream was quiet -> immediate
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
    t.push('b');
    t.push('c'); // coalesced, not yet run
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('c');
    t.dispose();
  });

  it('fires immediately when the stream has been quiet long enough', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const t = new TrailingEdgeThrottle(1000, fn);
    t.push('a');
    await vi.advanceTimersByTimeAsync(1500); // quiet period elapses
    t.push('b'); // now quiet >= interval -> immediate
    expect(fn).toHaveBeenCalledWith('b');
    t.dispose();
  });

  it('flush() runs any pending trailing edit and resolves', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const t = new TrailingEdgeThrottle(1000, fn);
    t.push('pending');
    await t.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('pending');
    t.dispose();
  });

  it('swallows errors from the underlying fn', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not modified'));
    const t = new TrailingEdgeThrottle(1000, fn);
    t.push('x');
    await expect(t.flush()).resolves.toBeUndefined();
    t.dispose();
  });
});
