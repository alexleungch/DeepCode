import { useSyncExternalStore } from 'react';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_INTERVAL_MS = 100;

/**
 * One shared 100ms ticker for EVERY spinner in the TUI (StatusBar, ToolCard, ThinkingLine).
 *
 * The old implementation installed a per-component `setInterval` for the component's whole
 * lifetime, so a long session with many tool cards kept N redundant timers firing 10×/s even
 * while idle (each bailed out of re-render via a ref, but the timer still ran).
 *
 * Now a single module-level interval advances a shared `tick` and notifies only the components
 * currently subscribed (i.e. actively spinning). When the last active spinner stops, the timer
 * is cleared entirely — an idle TUI runs ZERO spinner timers.
 */
let listeners = new Set<() => void>();
let tick = 0;
let timer: NodeJS.Timeout | undefined;

function ensureTicker(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick++;
    for (const l of listeners) l();
  }, SPINNER_INTERVAL_MS);
  // The spinner must never keep the process alive on its own (e.g. after a final frame).
  timer.unref?.();
}

function subscribeActive(cb: () => void): () => void {
  listeners.add(cb);
  ensureTicker();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Stable no-op subscription (returns an unsubscribe) — used when the spinner is inactive so
 *  React's subscribe identity stays constant (no re-subscribe churn on every render). */
const subscribeIdle = () => () => {};

/**
 * Animated spinner frame.
 *
 * Returns the current shared frame while `active` is true (the component subscribes to the
 * shared ticker and re-renders each tick), or a constant placeholder while inactive (no
 * subscription, no re-renders — `getSnapshot` stays constant so React bails out).
 */
export function useSpinnerFrame(active: boolean): string {
  return useSyncExternalStore(
    active ? subscribeActive : subscribeIdle,
    () => (active ? SPINNER_FRAMES[tick % SPINNER_FRAMES.length]! : '…'),
    () => (active ? SPINNER_FRAMES[0]! : '…'),
  );
}
