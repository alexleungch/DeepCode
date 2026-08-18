import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { parseMouse } from '../mouse.js';
import {
  computeRows,
  cursorPosition,
  editorReducer,
  initialEditorState,
  isMultiline,
  visibleWindow,
  type EditorAction,
  type WrappedRow,
} from './prompt-text.js';

/** Keep the historical export point for test harnesses (see PromptInputProps.testInput). */
export { pasteText } from './prompt-text.js';

interface PromptInputProps {
  disabled: boolean;
  onSubmit(text: string): void;
  placeholder?: string;
  /** Total width available to the input line (including the "❯ " prefix), in columns */
  width: number;
  /** Max visible lines before the box scrolls internally (the rest is reachable via the main-area PageUp). Default 6. */
  maxLines?: number;
  /** Test harness hook: called once per paste chunk so tests can feed real multi-line paste
   *  atomically (ink-testing-library can't deliver a bracketed-paste sequence today). */
  testInput?: (fn: (value: string) => void) => void;
}

/**
 * Bracketed-paste markers. Ink's input parser recognises `\x1b[200~` / `\x1b[201~` as CSI
 * sequences and passes them through `useInput` as `input`. Ink's `use-input` hook then strips
 * a leading ESC from any input that starts with one (see "Strip meta" in use-input.js), so the
 * handler actually receives the sequences WITHOUT the leading `\x1b`. We match on those
 * stripped forms. The bracketed-paste mode itself is enabled by the host TUI (app.tsx) on
 * startup via `\x1b[?2004h`.
 */
const PASTE_START = '[200~';
const PASTE_END = '[201~';

/**
 * Terminal input with full multi-line editing:
 * - Long input wraps to multiple lines instead of being truncated.
 * - A visible (inverse-video) cursor can be moved with ←/→/Home/End/Ctrl+A/Ctrl+E so you can
 *   jump back and fix earlier text; typing inserts at the cursor, Backspace/Delete remove there.
 * - Up/Down move the cursor between wrapped rows in multi-line input (so you can edit earlier
 *   lines), and cycle the command history in single-line input. Alt+Enter / Shift+Enter insert
 *   a literal newline. Tab completes slash commands.
 * - Multi-line paste is captured atomically via bracketed-paste markers (`\x1b[200~ … \x1b[201~`)
 *   so embedded `\n` bytes insert as text instead of triggering submit.
 *
 * All editing behaviour lives in the pure {@link editorReducer}; this component only maps
 * keystrokes to actions, keeps a live mirror of the state, and renders it.
 */
export function PromptInput({ disabled, onSubmit, placeholder, width, maxLines, testInput }: PromptInputProps) {
  // Editor state lives in a reducer; every keystroke dispatches one action. `stateRef` mirrors the
  // reducer output synchronously so the useInput handler can read the LATEST value/cursor even when
  // several keys arrive before React re-renders (a fast paste, or ink-testing-library typing at
  // 6ms/char). Reading render-closure state there would splice every batched keystroke at the same
  // stale cursor ("hello" -> "elhlo", "/help" -> "he/lp"). This replaces the old module-level
  // valueRef/cursorRef singletons, which were shared across every PromptInput instance.
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const stateRef = useRef(state);
  const apply = useCallback((action: EditorAction) => {
    stateRef.current = editorReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  // Bracketed-paste state — transient I/O, not part of the editor state.
  const pastingRef = useRef(false);
  const pasteBufferRef = useRef('');

  // Visible columns available to the text itself: total width minus "❯ " (2) and right margin (2).
  const textWidth = Math.max(10, width - 4);
  const MAX_VISIBLE = maxLines ?? 6;

  // Expose the atomic paste helper to test harnesses (one chunk = one input event in a real
  // terminal). Runs once on mount so a paste lands a single time instead of re-firing on every
  // render (the harness passes a fresh closure each render, which would otherwise re-paste).
  useEffect(() => {
    if (testInput) testInput((chunk: string) => apply({ type: 'insert', text: chunk }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the host disables the input (e.g. an agent run is in flight), clear what was typed.
  useEffect(() => {
    if (disabled) apply({ type: 'reset' });
  }, [disabled, apply]);

  useInput((input, key) => {
    if (disabled) return;

    // Host-reserved Ctrl combinations (Ctrl+O = expand, Ctrl+C = interrupt/exit via Ink, Ctrl+arrows
    // = home/end alias, …) must NOT leak into the editable buffer as literal text. Only the editor's
    // own Ctrl keys (A/E/U/K/W) are consumed here; everything else is left for the host TUI's
    // useInput handler. Without this guard, Ctrl+O would both toggle expansion AND insert an 'o'.
    if (key.ctrl && input && !['a', 'e', 'u', 'k', 'w'].includes(input.toLowerCase())) return;

    // Mouse wheel/clicks arrive via stdin as SGR sequences (`[<64;x;yM`, …) when mouse tracking is
    // enabled. They are handled by the host TUI (app.tsx); ignore them here so they never leak into
    // the editable buffer as literal text.
    if (parseMouse(input)) return;

    // Bracketed paste handling. Ink strips the leading ESC from CSI-shaped inputs, so the markers
    // arrive as `[200~` (start) and `[201~` (end). Between them, accumulate every event verbatim —
    // this is what lets a multi-line paste land as a single atomic edit (with its `\n` bytes intact)
    // instead of each `\n` triggering Enter/submit.
    if (pastingRef.current) {
      if (input === PASTE_END) {
        pastingRef.current = false;
        const chunk = pasteBufferRef.current;
        pasteBufferRef.current = '';
        if (chunk) apply({ type: 'insert', text: chunk });
      } else {
        pasteBufferRef.current += input;
      }
      return;
    }
    if (input === PASTE_START) {
      pastingRef.current = true;
      pasteBufferRef.current = '';
      return;
    }

    const s = stateRef.current; // live state — never stale between renders

    if (key.return) {
      // Alt+Enter / Shift+Enter insert a literal newline (multi-line input); a plain Enter
      // submits. (Ink reports the Alt key as `meta`.)
      if (key.meta || key.shift) {
        apply({ type: 'insert', text: '\n' });
        return;
      }
      const text = s.value.trim();
      if (text) {
        apply({ type: 'submit', text });
        onSubmit(text);
      }
      return;
    }
    // Cycle through the matching slash commands; repeated Tab advances to the next match.
    // Shift+Tab is reserved by the host TUI for mode cycling, so it must not trigger completion.
    if (key.tab && !key.shift) {
      apply({ type: 'tabComplete' });
      return;
    }
    // Cursor motion (checked before the Ctrl editing keys so Ctrl+A / Ctrl+E keep working).
    if (key.home || (key.ctrl && input === 'a')) {
      apply({ type: 'moveTo', pos: 'start' });
      return;
    }
    if (key.end || (key.ctrl && input === 'e')) {
      apply({ type: 'moveTo', pos: 'end' });
      return;
    }
    if (key.leftArrow) {
      apply({ type: 'moveTo', pos: 'left' });
      return;
    }
    if (key.rightArrow) {
      apply({ type: 'moveTo', pos: 'right' });
      return;
    }
    // Delete ranges.
    if (key.ctrl && input === 'u') {
      apply({ type: 'deleteToStart' });
      return;
    }
    if (key.ctrl && input === 'k') {
      apply({ type: 'deleteToEnd' });
      return;
    }
    if (key.ctrl && input === 'w') {
      apply({ type: 'deleteWordBefore' });
      return;
    }
    // Ink 6 parses the terminal-sent \x7f (the Backspace key on most terminals) as delete, so treat
    // both as "delete the character before the cursor" (readline behaviour).
    if (key.backspace || key.delete) {
      apply({ type: 'deleteBefore' });
      return;
    }
    // Up/Down move the cursor between wrapped rows in multi-line input (so you can go back and edit
    // earlier text); in single-line input they cycle the command history instead.
    if (key.upArrow) {
      if (isMultiline(s.value, textWidth)) apply({ type: 'moveVertical', direction: -1, textWidth });
      else apply({ type: 'historyUp' });
      return;
    }
    if (key.downArrow) {
      if (isMultiline(s.value, textWidth)) apply({ type: 'moveVertical', direction: 1, textWidth });
      else apply({ type: 'historyDown' });
      return;
    }
    if (key.escape) return;
    // Printable input: insert at the cursor (code-point aware).
    if (input) apply({ type: 'insert', text: input });
  });

  // Derived layout for rendering.
  const chars = [...state.value];
  const rows = computeRows(chars, textWidth);
  const pos = cursorPosition(chars, state.cursor, textWidth);
  const multi = isMultiline(state.value, textWidth);
  const win = visibleWindow(rows.length, pos.row, MAX_VISIBLE);
  const shown = rows.slice(win.start, win.end);

  // Render one cursor row: text before the cursor, an inverse-video cursor, text after it.
  const renderCursorRow = (row: WrappedRow, cursorCol: number) => {
    const prefix = row.chars.slice(0, cursorCol);
    const cursorChar = row.chars[cursorCol];
    const suffix = row.chars.slice(cursorCol + 1);
    // Ink trims trailing whitespace from every rendered line, so a blank inverse block at the
    // end of a line is never visible. Use a visible half-block glyph for the cursor there.
    const glyph = cursorChar !== undefined && cursorChar !== ' ' ? cursorChar : '▌';
    return (
      <>
        <Text>{prefix.join('')}</Text>
        <Text inverse>{glyph}</Text>
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
        {state.value === '' ? (
          <Text>
            <Text inverse>▌</Text>
            <Text color={theme.muted}>{placeholder ?? 'Type a message…'}</Text>
          </Text>
        ) : (
          <Box flexDirection="column">
            {win.start > 0 ? <Text color={theme.muted}>… (↑ 更多内容在上方)</Text> : null}
            {shown.map((row, i) => {
              const absRow = win.start + i;
              return (
                <Text key={i}>
                  {i > 0 ? '  ' : ''}
                  {absRow === pos.row ? renderCursorRow(row, pos.lineCharIndex) : row.chars.join('')}
                </Text>
              );
            })}
            {win.end < rows.length ? <Text color={theme.muted}>… (↓ 更多内容在下方)</Text> : null}
            {/* A second trailing blank line keeps the terminal from clipping the last row of a
                multi-line paste while the cursor is on it (Ink shrinks the wrapper to content). */}
            {multi ? <Text>{'  '}</Text> : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}
