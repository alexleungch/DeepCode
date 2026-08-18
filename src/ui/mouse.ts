/**
 * SGR (extended) mouse-event parsing.
 *
 * When the terminal's mouse tracking is enabled (DECSET 1000) together with SGR extended
 * coordinates (DECSET 1006 — both enabled for the TUI session in cli.ts), wheel/clicks arrive on
 * stdin as `ESC [ < b ; x ; y M` (press) / `ESC [ < b ; x ; y m` (release). Ink's input parser
 * groups that as a single CSI sequence and its `useInput` hook strips the leading ESC, so our
 * handlers receive the stripped form `[<b;x;yM` / `[<b;x;ym`.
 */

const SGR_MOUSE_RE = /^\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface MouseEvent {
  /** SGR button code: 64=wheel-up, 65=wheel-down, 0=left, 1=middle, 2=right, … */
  button: number;
  /** 1-based column */
  x: number;
  /** 1-based row */
  y: number;
  /** true for the press (`M`) half, false for the release (`m`) half */
  press: boolean;
}

/** Parse an Ink `input` string into an SGR mouse event, or `null` if it is not one. */
export function parseMouse(input: string): MouseEvent | null {
  const m = SGR_MOUSE_RE.exec(input);
  if (!m) return null;
  return {
    button: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    press: m[4] === 'M',
  };
}

/** SGR button codes for the wheel (xterm convention). */
export const WHEEL_UP = 64;
export const WHEEL_DOWN = 65;
