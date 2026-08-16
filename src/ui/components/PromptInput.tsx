import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

interface PromptInputProps {
  disabled: boolean;
  onSubmit(text: string): void;
  placeholder?: string;
  /** Total width available to the input line (including the "❯ " prefix), in columns */
  width: number;
}

/** Slash commands available in the TUI (used for Tab completion) */
const SLASH_COMMANDS = ['help', 'key', 'models', 'cost', 'usage', 'context', 'compact', 'clear', 'exit', 'quit'];

/** Slash-command candidates matching the current input ("" prefix matches all) */
function commandMatches(value: string): string[] {
  const m = /^\/([a-zA-Z][a-zA-Z0-9-]*)?$/.exec(value);
  if (!m) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(m[1]?.toLowerCase() ?? ''));
}

/** Visible width of a single code point (CJK / fullwidth / emoji count as 2 columns). */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK Radicals … Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth signs
    (code >= 0x1f300 && code <= 0x1faff) // Emoji (approx.)
  ) {
    return 2;
  }
  return 1;
}

interface WrappedLine {
  text: string;
  chars: string[];
}

/** Split code points into lines that each fit within `textWidth` visible columns.
 *  Literal '\n' forces a line break (multi-line input via Alt+Enter). */
function wrapChars(chars: string[], textWidth: number): WrappedLine[] {
  const lines: WrappedLine[] = [];
  let cur: string[] = [];
  let w = 0;
  const flush = () => {
    lines.push({ text: cur.join(''), chars: cur });
    cur = [];
    w = 0;
  };
  for (const ch of chars) {
    if (ch === '\n') {
      flush();
      continue;
    }
    const cw = charWidth(ch);
    if (cur.length > 0 && w + cw > textWidth) {
      flush();
    }
    cur.push(ch);
    w += cw;
  }
  flush();
  return lines;
}

interface CursorPos {
  row: number;
  /** Index of the cursor within its wrapped line (code-point offset) */
  lineCharIndex: number;
}

/** Compute the on-screen position of the cursor (row + in-line char index). */
function cursorPos(chars: string[], cursor: number, textWidth: number): CursorPos {
  let row = 0;
  let col = 0;
  let lineCharIndex = 0;
  for (let i = 0; i < cursor; i++) {
    const ch = chars[i]!;
    if (ch === '\n') {
      row++;
      col = 0;
      lineCharIndex = 0;
      continue;
    }
    const cw = charWidth(ch);
    if (col + cw > textWidth) {
      row++;
      col = 0;
      lineCharIndex = 0;
    }
    col += cw;
    lineCharIndex++;
  }
  return { row, lineCharIndex };
}

/**
 * Terminal input with full multi-line editing:
 * - Long input wraps to multiple lines instead of being truncated.
 * - A visible (inverse-video) cursor can be moved with ←/→/Home/End/Ctrl+A/Ctrl+E so you can
 *   jump back and fix earlier text; typing inserts at the cursor, Backspace/Delete remove there.
 * - Up/Down still cycle the command history; Tab completes slash commands.
 */
export function PromptInput({ disabled, onSubmit, placeholder, width }: PromptInputProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  // Visible columns available to the text itself: total width minus "❯ " (2) and right margin (2).
  const textWidth = Math.max(10, width - 4);
  const chars = [...value];
  const lines = wrapChars(chars, textWidth);
  const pos = cursorPos(chars, cursor, textWidth);

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      // Alt+Enter / Shift+Enter insert a literal newline (multi-line input);
      // a plain Enter submits. (Ink reports the Alt key as `meta`.)
      if (key.meta || key.shift) {
        setValue((v) => {
          const cs = [...v];
          cs.splice(cursor, 0, '\n');
          return cs.join('');
        });
        setCursor((c) => c + 1);
        return;
      }
      const text = value.trim();
      if (text) {
        setHistory((h) => [text, ...h].slice(0, 50));
        setHistIdx(-1);
        setValue('');
        setCursor(0);
        onSubmit(text);
      }
      return;
    }
    if (key.tab) {
      // Cycle through the matching slash commands; repeated Tab advances to the next match
      const matches = commandMatches(value);
      if (matches.length > 0) {
        const current = value.slice(1).toLowerCase();
        const idx = matches.indexOf(current);
        const next = matches[(idx + 1) % matches.length];
        if (next) {
          const completed = '/' + next;
          setValue(completed);
          setCursor(completed.length);
        }
      }
      return;
    }
    // Editing motion keys (checked before Ctrl so Ctrl+A/E keep working)
    if (key.home || (key.ctrl && input === 'a')) {
      setCursor(0);
      return;
    }
    if (key.end || (key.ctrl && input === 'e')) {
      setCursor(chars.length);
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(chars.length, c + 1));
      return;
    }
    if (key.ctrl && input === 'u') {
      // Delete from the cursor to the start of the line
      setValue((v) => [...v].slice(cursor).join(''));
      setCursor(0);
      return;
    }
    if (key.ctrl && input === 'k') {
      // Delete from the cursor to the end of the line
      setValue((v) => [...v].slice(0, cursor).join(''));
      return;
    }
    if (key.ctrl && input === 'w') {
      // Delete the word before the cursor
      const cs = [...value];
      let i = cursor;
      while (i > 0 && cs[i - 1] === ' ') i--;
      while (i > 0 && cs[i - 1] !== ' ') i--;
      setValue(cs.slice(0, i).join('') + cs.slice(cursor).join(''));
      setCursor(i);
      return;
    }
    if (key.backspace || key.delete) {
      // Ink 6 parses the terminal-sent \x7f (the Backspace key on most terminals) as delete,
      // so treat both as "delete the character before the cursor" (readline behaviour).
      setValue((v) => {
        const cs = [...v];
        const at = cursor - 1;
        if (at < 0) return v;
        cs.splice(at, 1);
        return cs.join('');
      });
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.upArrow) {
      setHistIdx((i) => {
        const next = i + 1;
        const item = history[next];
        if (item !== undefined) {
          setValue(item);
          setCursor([...item].length);
        }
        return Math.min(next, history.length - 1);
      });
      return;
    }
    if (key.downArrow) {
      setHistIdx((i) => {
        const next = i - 1;
        if (next < 0) {
          setValue('');
          setCursor(0);
          return -1;
        }
        const item = history[next];
        if (item !== undefined) {
          setValue(item);
          setCursor([...item].length);
        }
        return next;
      });
      return;
    }
    if (key.escape) return;
    if (input) {
      // Insert printable input at the cursor (code-point aware)
      const incoming = [...input];
      setValue((v) => {
        const cs = [...v];
        cs.splice(cursor, 0, ...incoming);
        return cs.join('');
      });
      setCursor((c) => c + incoming.length);
    }
  });

  useEffect(() => {
    if (disabled) {
      setValue('');
      setCursor(0);
    }
  }, [disabled]);

  const renderCursorContent = (line: WrappedLine) => {
    const prefix = line.chars.slice(0, pos.lineCharIndex);
    const cursorChar = line.chars[pos.lineCharIndex];
    const suffix = line.chars.slice(pos.lineCharIndex + 1);
    // Ink trims trailing whitespace from every rendered line, so a blank inverse block at the
    // end of a line is never visible. Use a visible half-block glyph for the cursor there.
    const cursorGlyph = cursorChar !== undefined && cursorChar !== ' ' ? cursorChar : '▌';
    return (
      <>
        <Text>{prefix.join('')}</Text>
        <Text inverse>{cursorGlyph}</Text>
        <Text>{suffix.join('')}</Text>
      </>
    );
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.primary} bold>
          ❯{' '}
        </Text>
        {value === '' ? (
          <Text>
            <Text inverse>▌</Text>
            <Text color={theme.muted}>{placeholder ?? 'Type a message…'}</Text>
          </Text>
        ) : (
          <Box flexDirection="column">
            {lines.map((line, i) => (
              <Text key={i}>
                {i > 0 ? '  ' : ''}
                {i === pos.row ? renderCursorContent(line) : line.text}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
