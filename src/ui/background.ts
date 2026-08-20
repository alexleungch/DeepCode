import { spawnSync } from 'node:child_process';
import { luminance } from './themes.js';

export type TerminalBackground = 'light' | 'dark';

const OSC11_RE_16 = /rgb:([0-9a-fA-F]{4})\/([0-9a-fA-F]{4})\/([0-9a-fA-F]{4})(?:\x07|\x1b\\)/;
const OSC11_RE_24 = /rgb:([0-9a-fA-F]{6})\/([0-9a-fA-F]{6})\/([0-9a-fA-F]{6})(?:\x07|\x1b\\)/;
// Some terminals answer the OSC 11 query with a plain `#RRGGBB` color.
const OSC11_RE_HEX = /#([0-9a-fA-F]{6})(?:\x07|\x1b\\)/;

/**
 * Probe the terminal background color with the OSC 11 query (`\x1b]11;?\x07`) and
 * wait for the response. Supported by most modern terminals (iTerm2, kitty, WezTerm,
 * Warp, Windows Terminal, VS Code, Ghostty, xterm, …) which answer with
 * `\x1b]11;rgb:RRRR/GGGG/BBBB\x07` (16-bit per channel) or the 24-bit
 * `rgb:RRRRRR/GGGGGG/BBBBBB` form. macOS Terminal.app does NOT answer, so we time
 * out and fall through to the AppleInterfaceStyle heuristic in
 * {@link detectTerminalBackground}.
 *
 * The query is issued BEFORE Ink mounts (no input handler competition), the one-shot
 * data listener is removed as soon as a response arrives, and a hard buffer/timeout
 * cap guarantees we never swallow subsequent user keystrokes.
 */
function queryOsc11Background(timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (v: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.length > 512) return finish(undefined); // malformed/no response — don't buffer forever
      const m = OSC11_RE_16.exec(buf) ?? OSC11_RE_24.exec(buf) ?? OSC11_RE_HEX.exec(buf);
      if (m) finish(m[0]);
    };
    process.stdin.on('data', onData);
    process.stdout.write('\x1b]11;?\x07');
  });
}

/** Normalize an OSC 11 response to `#rrggbb`, or undefined when unparseable.
 *  Exported for unit tests. Accepts the 16-bit `rgb:RRRR/GGGG/BBBB`, 24-bit
 *  `rgb:RRRRRR/GGGGGG/BBBBBB`, and `#RRGGBB` response forms — each channel's top
 *  byte becomes the corresponding #RRGGBB pair. */
export function osc11ToHex(response: string): string | undefined {
  const m16 = OSC11_RE_16.exec(response);
  if (m16) {
    const ch = (s: string) => s.slice(0, 2).toLowerCase(); // 16-bit value → top byte
    return `#${ch(m16[1]!)}${ch(m16[2]!)}${ch(m16[3]!)}`;
  }
  const m24 = OSC11_RE_24.exec(response);
  if (m24) {
    // 24-bit channel (6 hex digits) → its top byte is the #RRGGBB pair.
    const ch = (s: string) => s.slice(0, 2).toLowerCase();
    return `#${ch(m24[1]!)}${ch(m24[2]!)}${ch(m24[3]!)}`;
  }
  const mh = OSC11_RE_HEX.exec(response);
  if (mh) return `#${mh[1]!.toLowerCase()}`;
  return undefined;
}

/**
 * Fallback for terminals that do not answer OSC 11 (macOS Terminal.app). Terminal.app's
 * default profile follows the system appearance, so when macOS is in light mode we
 * assume a light terminal. Only consulted when TERM_PROGRAM is Apple_Terminal, so it
 * never misleads other terminals.
 */
function appleTerminalMode(): TerminalBackground | undefined {
  if (process.platform !== 'darwin' || process.env.TERM_PROGRAM !== 'Apple_Terminal') return undefined;
  try {
    const r = spawnSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { encoding: 'utf8', timeout: 1000 });
    // `defaults read` exits non-zero when the key is absent → light appearance.
    if (r.status === 0 && /dark/i.test(r.stdout ?? '')) return 'dark';
    return 'light';
  } catch {
    return undefined;
  }
}

/**
 * Best-effort terminal background detection: OSC 11 query first (accurate where
 * supported), then the Apple_Terminal appearance heuristic. Returns undefined when
 * the background cannot be determined (non-TTY stdin, no response, unknown terminal)
 * so callers fall back to the configured/default theme.
 */
export async function detectTerminalBackground(timeoutMs = 150): Promise<TerminalBackground | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const response = await queryOsc11Background(timeoutMs);
  if (response) {
    const hex = osc11ToHex(response);
    if (hex) return luminance(hex) >= 0.5 ? 'light' : 'dark';
  }
  return appleTerminalMode();
}
