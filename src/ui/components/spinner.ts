import { useEffect, useRef, useState } from 'react';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_INTERVAL_MS = 100;

/**
 * Animated spinner frame.
 *
 * A plain glyph would render once and freeze because no events fire during e.g. a slow tool run.
 * The interval lives for the whole component lifetime and only advances the visible frame while
 * `active` is true (a ref avoids re-rendering while idle). This is more reliable than starting the
 * interval in a `useEffect` gated on `active`: the effect restarts every time active toggles, and
 * between restarts the icon can look frozen.
 */
export function useSpinnerFrame(active: boolean): string {
  const [tick, setTick] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const id = setInterval(() => {
      // Returning the same tick while idle makes React bail out (no re-render).
      setTick((t) => (activeRef.current ? t + 1 : t));
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
}
