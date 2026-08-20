/**
 * Clipboard utility for the TUI.
 *
 * Terminals that support OSC 52 (the "clipboard" escape sequence) can have text
 * copied to the system clipboard without any native bindings. This module writes
 * the OSC 52 sequence to stdout when available, and gracefully degrades on
 * terminals that don't support it (most modern terminal emulators do: iTerm2,
 * macOS Terminal.app, Windows Terminal, VS Code integrated terminal, etc.).
 *
 * Usage:
 *   import { copyToClipboard } from './clipboard.js';
 *   await copyToClipboard('text to copy');  // returns true if successful
 */

/** Detect whether the current terminal likely supports OSC 52.
 *  Checks common environment variables and terminal identifiers.
 */
export function supportsClipboard(): boolean {
  // These terminals are known to support OSC 52
  const term = process.env.TERM ?? '';
  const termProgram = process.env.TERM_PROGRAM ?? '';
  const supportedTerms = [
    'xterm-256color',
    'xterm-kitty',
    'screen',
    'tmux',
    'wezterm',
    'alacritty',
    'rio',
  ];
  const supportedPrograms = [
    'iTerm.app',
    'Apple_Terminal',
    'vscode',
    'Hyper',
    'WezTerm',
    'Alacritty',
    'Windows Terminal',
  ];

  return (
    supportedTerms.some((t) => term.includes(t)) ||
    supportedPrograms.some((p) => termProgram.includes(p)) ||
    // SSH sessions often forward OSC 52 if configured
    !!process.env.SSH_CONNECTION ||
    // WSL typically supports it through Windows Terminal
    process.env.WSL_DISTRO_NAME !== undefined
  );
}

/**
 * Copy text to the system clipboard via OSC 52.
 *
 * The OSC 52 escape sequence format is:
 *   \x1b]52;c;{base64-encoded-text}\x07
 *
 * Where 'c' is the clipboard target ('c' = clipboard, 'p' = primary selection).
 *
 * @param text - The text to copy
 * @param silent - If true, don't throw on failure, just return false
 * @returns true if the write succeeded (best-effort detection)
 */
export async function copyToClipboard(text: string, silent = false): Promise<boolean> {
  if (!text) return false;

  try {
    // Base64 encode the content for OSC 52
    const base64 = Buffer.from(text, 'utf-8').toString('base64');
    const osc52 = `\x1b]52;c;${base64}\x07`;

    // Write directly to stdout (the TUI's output stream)
    process.stdout.write(osc52);

    return true;
  } catch (e) {
    if (!silent) {
      console.error('[clipboard] Failed to copy:', e instanceof Error ? e.message : e);
    }
    return false;
  }
}

/**
 * Format a tool result or code block for clipboard copying.
 * Strips ANSI formatting and prepares clean text.
 */
export function formatForClipboard(content: string): string {
  // Strip ANSI escape codes
  const stripped = content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  // Strip the ⎿ prefix lines that we add in ToolCard results
  const lines = stripped.split('\n').map((l) => l.replace(/^⎿\s*/, ''));
  return lines.join('\n').trim();
}
