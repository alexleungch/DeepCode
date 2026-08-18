/**
 * Pure text-editing engine for {@link PromptInput} — no React / Ink dependencies, so the wrap,
 * cursor and history logic is unit-testable in isolation.
 *
 * Conventions:
 * - Cursor positions are code-point offsets into `[...value]`, so astral-plane characters
 *   (emoji, extended CJK) are never split in half.
 * - Every edit is a tagged action applied by {@link editorReducer}; the component only maps
 *   keystrokes to actions and renders the resulting state.
 */

/** Slash commands offered by Tab completion. */
export const SLASH_COMMANDS = [
  'help',
  'theme',
  'key',
  'models',
  'cost',
  'usage',
  'context',
  'compact',
  'clear',
  'exit',
  'quit',
];

/* ---------------------------------------------------------------------------
 * Editor state machine
 * ------------------------------------------------------------------------- */

export interface EditorState {
  /** Raw input text. */
  value: string;
  /** Cursor position as a code-point offset into `value`. */
  cursor: number;
  /** Submitted lines, newest first (bounded). */
  history: string[];
  /** Index into `history` while browsing; -1 when not browsing. */
  histIdx: number;
}

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'deleteBefore' }
  | { type: 'deleteWordBefore' }
  | { type: 'deleteToStart' }
  | { type: 'deleteToEnd' }
  | { type: 'moveTo'; pos: 'start' | 'end' | 'left' | 'right' }
  | { type: 'moveVertical'; direction: 1 | -1; textWidth: number }
  | { type: 'historyUp' }
  | { type: 'historyDown' }
  | { type: 'tabComplete' }
  | { type: 'submit'; text: string }
  | { type: 'reset' };

export const initialEditorState: EditorState = { value: '', cursor: 0, history: [], histIdx: -1 };

const HISTORY_LIMIT = 50;

/** Replace value + cursor, keeping history / histIdx untouched. */
function withText(state: EditorState, value: string, cursor: number): EditorState {
  return { ...state, value, cursor };
}

/** Index of the start of the word before `cursor` (readline Ctrl+W: skip spaces, then the word). */
function wordStartBefore(chars: string[], cursor: number): number {
  let i = cursor;
  while (i > 0 && chars[i - 1] === ' ') i--;
  while (i > 0 && chars[i - 1] !== ' ') i--;
  return i;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'insert': {
      const { value, cursor } = pasteText(state.value, state.cursor, action.text);
      return withText(state, value, cursor);
    }

    case 'deleteBefore': {
      if (state.cursor <= 0) return state;
      const chars = [...state.value];
      chars.splice(state.cursor - 1, 1);
      return withText(state, chars.join(''), state.cursor - 1);
    }

    case 'deleteWordBefore': {
      const chars = [...state.value];
      const start = wordStartBefore(chars, state.cursor);
      return start === state.cursor
        ? state
        : withText(state, chars.slice(0, start).concat(chars.slice(state.cursor)).join(''), start);
    }

    case 'deleteToStart': {
      return withText(state, [...state.value].slice(state.cursor).join(''), 0);
    }

    case 'deleteToEnd': {
      return withText(state, [...state.value].slice(0, state.cursor).join(''), state.cursor);
    }

    case 'moveTo': {
      const chars = [...state.value];
      const cursor =
        action.pos === 'start'
          ? 0
          : action.pos === 'end'
            ? chars.length
            : action.pos === 'left'
              ? Math.max(0, state.cursor - 1)
              : Math.min(chars.length, state.cursor + 1);
      return withText(state, state.value, cursor);
    }

    case 'moveVertical': {
      const next = moveVertical([...state.value], state.cursor, action.textWidth, action.direction);
      return withText(state, state.value, next);
    }

    case 'historyUp': {
      const next = state.histIdx + 1;
      const item = state.history[next];
      const histIdx = Math.min(next, state.history.length - 1);
      if (item === undefined) return { ...state, histIdx };
      return withText({ ...state, histIdx }, item, [...item].length);
    }

    case 'historyDown': {
      const next = state.histIdx - 1;
      if (next < 0) return { ...state, value: '', cursor: 0, histIdx: -1 };
      const item = state.history[next]!;
      return withText({ ...state, histIdx: next }, item, [...item].length);
    }

    case 'tabComplete': {
      const matches = commandMatches(state.value);
      if (matches.length === 0) return state;
      const current = state.value.slice(1).toLowerCase();
      const next = matches[(matches.indexOf(current) + 1) % matches.length];
      if (next === undefined) return state;
      return withText(state, '/' + next, next.length + 1);
    }

    case 'submit': {
      if (action.text === '') return state;
      return {
        ...state,
        value: '',
        cursor: 0,
        histIdx: -1,
        history: [action.text, ...state.history].slice(0, HISTORY_LIMIT),
      };
    }

    case 'reset': {
      return { ...state, value: '', cursor: 0 };
    }
  }
}

/* ---------------------------------------------------------------------------
 * Terminal text layout (code-point aware wrapping & cursor math)
 * ------------------------------------------------------------------------- */

export interface WrappedRow {
  /** Offset into the original char array where this row begins. */
  startCursor: number;
  /** Code points on this row; never contains '\n'. */
  chars: string[];
}

/** Wrap `chars` into rows that each fit `textWidth` visible columns; a literal '\n' forces a break. */
export function computeRows(chars: string[], textWidth: number): WrappedRow[] {
  const rows: WrappedRow[] = [];
  let cur: string[] = [];
  let w = 0;
  let rowStart = 0;
  const flush = (nextStart: number) => {
    rows.push({ startCursor: rowStart, chars: cur });
    cur = [];
    w = 0;
    rowStart = nextStart;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '\n') {
      flush(i + 1);
      continue;
    }
    const cw = charWidth(ch);
    if (cur.length > 0 && w + cw > textWidth) {
      flush(i);
    }
    cur.push(ch);
    w += cw;
  }
  flush(chars.length);
  return rows;
}

export interface CursorPosition {
  /** Wrapped row the cursor is on. */
  row: number;
  /** Cursor offset within that row, in code points. */
  lineCharIndex: number;
}

/** On-screen cursor position, using the same wrap rule as computeRows. */
export function cursorPosition(chars: string[], cursor: number, textWidth: number): CursorPosition {
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

/** True when the value spans more than one on-screen line (literal newline or wrapping). */
export function isMultiline(value: string, textWidth: number): boolean {
  return value.includes('\n') || computeRows([...value], textWidth).length > 1;
}

export interface VisibleWindow {
  start: number;
  end: number;
}

/**
 * The window of rows to render when the input is taller than `maxLines`, anchored on the cursor
 * row (readline-style) so the cursor is always on screen and the box scrolls with it.
 */
export function visibleWindow(totalRows: number, cursorRow: number, maxLines: number): VisibleWindow {
  if (totalRows <= maxLines) return { start: 0, end: totalRows };
  const end = Math.min(totalRows, Math.max(0, cursorRow - maxLines + 1) + maxLines);
  return { start: end - maxLines, end };
}

/**
 * Move the cursor one wrapped row up (-1) or down (+1), preserving the visible column as closely
 * as possible (readline-style vertical motion). Returns the cursor unchanged when there is no row
 * in that direction.
 */
export function moveVertical(chars: string[], cursor: number, textWidth: number, direction: 1 | -1): number {
  const rows = computeRows(chars, textWidth);
  if (rows.length <= 1) return cursor;
  // Locate the row the cursor sits on (at a row boundary the row above wins, readline-style),
  // plus the visible column within it.
  let curRow = 0;
  let lineCharIndex = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const end = row.startCursor + row.chars.length;
    if (cursor >= row.startCursor && cursor <= end) {
      curRow = r;
      lineCharIndex = cursor - row.startCursor;
      break;
    }
  }
  const targetRow = curRow + direction;
  if (targetRow < 0 || targetRow >= rows.length) return cursor;
  // Visible column of the current cursor position.
  const curRowChars = rows[curRow]!.chars;
  let col = 0;
  for (let i = 0; i < lineCharIndex; i++) col += charWidth(curRowChars[i]!);
  // Walk the target row until we reach or overshoot the desired column.
  const targetLine = rows[targetRow]!.chars;
  let newCol = 0;
  let newLineCharIndex = 0;
  for (let i = 0; i < targetLine.length; i++) {
    const cw = charWidth(targetLine[i]!);
    if (newCol + cw > col) break;
    newCol += cw;
    newLineCharIndex = i + 1;
  }
  return rows[targetRow]!.startCursor + newLineCharIndex;
}

/* ---------------------------------------------------------------------------
 * Text primitives
 * ------------------------------------------------------------------------- */

/** Visible width of a single code point (CJK / fullwidth / emoji count as 2 columns). */
export function charWidth(ch: string): number {
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

/**
 * Insert `chunk` at `cursor` in one atomic edit — exactly like a terminal paste, so embedded '\n'
 * bytes land as text instead of triggering submit. Returns the new value + cursor.
 */
export function pasteText(value: string, cursor: number, chunk: string): { value: string; cursor: number } {
  const chars = [...value];
  const incoming = [...chunk];
  chars.splice(cursor, 0, ...incoming);
  return { value: chars.join(''), cursor: cursor + incoming.length };
}

/** Slash-command candidates matching the current input ("" prefix matches all). */
export function commandMatches(value: string): string[] {
  const m = /^\/([a-zA-Z][a-zA-Z0-9-]*)?$/.exec(value);
  if (!m) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(m[1]?.toLowerCase() ?? ''));
}
