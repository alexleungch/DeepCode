import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { parseMouse } from '../mouse.js';
import { atCandidates } from '../at-complete.js';
import {
  atSpanAtCursor,
  atTokens,
  computeRows,
  cursorPosition,
  editorReducer,
  initialEditorState,
  isMultiline,
  segmentChars,
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
  /** Workspace cwd for `@file` tab completion (omitted → no @ completion, Tab only completes slash commands) */
  cwd?: string;
  /** Called with the matching candidates when Tab completes an @-ref with 2+ matches (for a hint notice) */
  onAtMatches?: (candidates: string[]) => void;
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

/** Max candidate rows shown in the live `@` file-list popup (the rest are reachable by typing). */
const MAX_MENU = 8;

/**
 * Terminal input with full multi-line editing:
 * - Long input wraps to multiple lines instead of being truncated.
 * - A visible (inverse-video) cursor can be moved with ←/→/Home/End/Ctrl+A/Ctrl+E so you can
 *   jump back and fix earlier text; typing inserts at the cursor, Backspace/Delete remove there.
 * - Up/Down move the cursor between wrapped rows in multi-line input (so you can edit earlier
 *   lines), and cycle the command history in single-line input. Alt+Enter / Shift+Enter insert
 *   a literal newline. Typing `@` opens a live file-list popup that tracks the typed prefix;
 *   ↑/↓ move its highlight and Tab inserts the highlighted entry (directories get a trailing `/`
 *   so Tab can descend). The ref is rendered highlighted and expanded on submit by the agent
 *   loop (see src/agent/at-refs.ts).
 * - Multi-line paste is captured atomically via bracketed-paste markers (`\x1b[200~ … \x1b[201~`)
 *   so embedded `\n` bytes insert as text instead of triggering submit.
 *
 * All editing behaviour lives in the pure {@link editorReducer}; this component only maps
 * keystrokes to actions, keeps a live mirror of the state, and renders it.
 *
 * Memoized: the host TUI re-renders every 16ms while the agent streams, but the editor only
 * changes when the user types — the memo (with stable `onSubmit`/`onAtMatches` callbacks from
 * the host) lets it skip those frames entirely.
 */
export const PromptInput = React.memo(function PromptInput({ disabled, onSubmit, placeholder, width, maxLines, cwd, onAtMatches, testInput }: PromptInputProps) {
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

  // Live `@`-file-list popup: the highlighted candidate index + a ref mirror (so the useInput
  // handler — registered once — always reads the latest highlight) + a suppress flag used to
  // hide the popup right after a *file* (non-directory) completion so it doesn't immediately
  // re-open on the just-inserted token. The popup itself is derived each render from the
  // current `@`-span, so it tracks the user's typing automatically.
  const [menuIndex, setMenuIndexState] = useState(0);
  const menuIndexRef = useRef(0);
  const setMenu = useCallback((i: number) => {
    menuIndexRef.current = i;
    setMenuIndexState(i);
  }, []);
  const menuSuppressRef = useRef(false);

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

    // Live `@`-file-list popup: ↑/↓ move the highlight while it is open. This only fires when the
    // cursor is inside an `@`-ref with matches, so single-line history cycling / multi-line cursor
    // motion are untouched the rest of the time.
    if (cwd) {
      const span = atSpanAtCursor(s.value, s.cursor);
      if (span) {
        const cands = atCandidates(span.partial, cwd);
        if (cands.length > 0 && !menuSuppressRef.current && (key.upArrow || key.downArrow)) {
          const dir = key.upArrow ? -1 : 1;
          setMenu(Math.min(Math.max(0, menuIndexRef.current + dir), cands.length - 1));
          return;
        }
      }
    }

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
    // Tab completes. Two modes: inside an `@path` ref, Tab inserts the highlighted file/dir
    // from the live list (directories get a trailing `/` so Tab can descend; completing a file
    // closes the list); otherwise it cycles slash commands. Shift+Tab is reserved by the host
    // TUI for mode cycling, so it must not trigger completion.
    if (key.tab && !key.shift) {
      const span = cwd ? atSpanAtCursor(s.value, s.cursor) : null;
      if (span) {
        const cands = atCandidates(span.partial, cwd ?? '');
        if (cands.length > 0 && !menuSuppressRef.current) {
          const idx = Math.min(menuIndexRef.current, cands.length - 1);
          const cand = cands[idx]!;
          // completeAt replaces the whole `@partial` span, so re-attach the `@` prefix.
          apply({ type: 'completeAt', value: '@' + cand.value + (cand.isDir ? '/' : '') });
          setMenu(0);
          menuSuppressRef.current = !cand.isDir; // hide the list after a file, keep it for dirs
          if (cands.length > 1 && onAtMatches) {
            onAtMatches(cands.map((c) => c.value + (c.isDir ? '/' : '')));
          }
        }
        return;
      }
      apply({ type: 'tabComplete' });
      return;
    }
    // Cursor motion (checked before the Ctrl editing keys so Ctrl+A / Ctrl+E keep working).
    // PLAIN Home/End move the cursor; Ctrl+Home/Ctrl+End are reserved by the host TUI for
    // history scrolling (app.tsx), so they must NOT also yank the cursor here.
    if ((!key.ctrl && key.home) || (key.ctrl && input === 'a')) {
      apply({ type: 'moveTo', pos: 'start' });
      return;
    }
    if ((!key.ctrl && key.end) || (key.ctrl && input === 'e')) {
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
      menuSuppressRef.current = false;
      apply({ type: 'deleteToStart' });
      return;
    }
    if (key.ctrl && input === 'k') {
      menuSuppressRef.current = false;
      apply({ type: 'deleteToEnd' });
      return;
    }
    if (key.ctrl && input === 'w') {
      menuSuppressRef.current = false;
      apply({ type: 'deleteWordBefore' });
      return;
    }
    // Ink 6 parses the terminal-sent \x7f (the Backspace key on most terminals) as delete, so treat
    // both as "delete the character before the cursor" (readline behaviour).
    if (key.backspace || key.delete) {
      menuSuppressRef.current = false; // an edit re-opens the `@` list if the cursor is back on a ref
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
    if (input) {
      menuSuppressRef.current = false; // typing re-opens the `@` list (e.g. after a file completion)
      apply({ type: 'insert', text: input });
    }
  });

  // Derived layout for rendering.
  const chars = [...state.value];
  const rows = computeRows(chars, textWidth);
  const pos = cursorPosition(chars, state.cursor, textWidth);
  const multi = isMultiline(state.value, textWidth);
  const win = visibleWindow(rows.length, pos.row, MAX_VISIBLE);
  const shown = rows.slice(win.start, win.end);
  // @-ref spans across the whole value (for highlight segments below).
  const tokens = atTokens(state.value);

  // Live `@`-file-list popup: derive the candidate list from the `@`-span under the cursor so it
  // tracks typing automatically (typing `@` alone lists the cwd; typing more filters by prefix).
  // It is hidden right after a *file* completion (menuSuppressRef) and whenever there are no matches.
  const atSpan = cwd ? atSpanAtCursor(state.value, state.cursor) : null;
  const atCands = atSpan ? atCandidates(atSpan.partial, cwd ?? '') : [];
  const menuOpen = atCands.length > 0 && !menuSuppressRef.current;
  const selected = Math.min(menuIndex, Math.max(0, atCands.length - 1));
  // Reset the highlight to the first row whenever the partial being completed changes.
  useEffect(() => {
    setMenu(0);
  }, [atSpan?.partial]);


  // Render one non-cursor row, coloring `@ref` spans with the accent color.
  const renderRow = (row: WrappedRow) => (
    <>
      {segmentChars(row.chars, row.startCursor, tokens).map((seg, si) => (
        <Text key={si} color={seg.isRef ? theme.user : undefined}>
          {seg.text}
        </Text>
      ))}
    </>
  );

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
        {segmentChars(prefix, row.startCursor, tokens).map((seg, si) => (
          <Text key={`p${si}`} color={seg.isRef ? theme.user : undefined}>
            {seg.text}
          </Text>
        ))}
        <Text inverse>{glyph}</Text>
        {segmentChars(suffix, row.startCursor + cursorCol + 1, tokens).map((seg, si) => (
          <Text key={`s${si}`} color={seg.isRef ? theme.user : undefined}>
            {seg.text}
          </Text>
        ))}
      </>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Live `@`-file-list popup: appears the moment the cursor is on an `@`-ref and lists the
          matching files/dirs. ↑/↓ move the highlight, Tab inserts it. Rendered above the input
          prompt line, inside the (bordered) input box, so it reads as an inline suggestion list. */}
      {menuOpen ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.muted}>
            {`Attach file — ${atCands.length} match${atCands.length === 1 ? '' : 'es'} · ↑/↓ move · Tab insert`}
          </Text>
          {atCands.slice(0, MAX_MENU).map((c, i) => {
            const isSel = i === selected;
            const label = c.value + (c.isDir ? '/' : '');
            return (
              <Text key={c.value} color={isSel ? theme.primary : theme.muted} bold={isSel}>
                {isSel ? '▶ ' : '  '}
                {c.isDir ? '▸ ' : '  '}
                {label}
              </Text>
            );
          })}
          {atCands.length > MAX_MENU ? (
            <Text color={theme.muted}>… +{atCands.length - MAX_MENU} more (keep typing to filter)</Text>
          ) : null}
        </Box>
      ) : null}
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
            {win.start > 0 ? <Text color={theme.muted}>… (↑ more above)</Text> : null}
            {shown.map((row, i) => {
              const absRow = win.start + i;
              return (
                <Text key={i}>
                  {i > 0 ? '  ' : ''}
                  {absRow === pos.row ? renderCursorRow(row, pos.lineCharIndex) : renderRow(row)}
                </Text>
              );
            })}
            {win.end < rows.length ? <Text color={theme.muted}>… (↓ more below)</Text> : null}
            {/* A second trailing blank line keeps the terminal from clipping the last row of a
                multi-line paste while the cursor is on it (Ink shrinks the wrapper to content). */}
            {multi ? <Text>{'  '}</Text> : null}
          </Box>
        )}
      </Box>
    </Box>
  );
});
