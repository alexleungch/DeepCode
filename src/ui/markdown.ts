/**
 * Lightweight Markdown renderer: converts markdown text into styled line blocks.
 * Supports: headings, bold/italic, inline code, code blocks, lists, task lists, tables,
 * quotes, horizontal rules.
 * The output structure is rendered line by line by Ink <Text> (avoids a heavy highlight dependency).
 *
 * Each StyledLine keeps a plain `text` (the concatenation of its segments) for compatibility
 * with --print / plain rendering, plus an optional `segments` array carrying per-run styles
 * (bold/italic/code/link) so the Ink renderer can apply real ANSI styles instead of just
 * stripping the markers.
 */

import { charWidth } from './components/prompt-text.js';

export interface StyledSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
}

interface StyledLine {
  /** Style marker used for rendering */
  kind: 'h1' | 'h2' | 'h3' | 'code' | 'list' | 'quote' | 'hr' | 'text' | 'empty';
  /** Plain concatenated text (no markers) — always present for plain/print renderers */
  text: string;
  /** Per-run styles (optional; absent for plain text) */
  segments?: StyledSegment[];
  /** Code fence language, e.g. 'ts' (kind === 'code' only) */
  codeLang?: string;
  /** Task-list state (kind === 'list' only) */
  task?: boolean;
  checked?: boolean;
}

const CODE_BLOCK_RE = /^```(\w*)\s*$/;
const TASK_RE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;
// Separator row: one or more dash cells (with optional alignment colons) separated by pipes,
// optionally wrapped in leading/trailing pipes: `|---|---|`, `|:--|--:|`, `| --- |` or bare `---`.
// Must be ONLY dashes/colons/spaces/pipes (no letters/digits), so `| a | --- |` stays a data row.
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Display width of a string in a monospace terminal (CJK/wide chars count as 2). */
const WIDE_CHAR_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFF00-\uFF60\uFFE0-\uFFE6]/;
function dlen(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return n;
}

/** Parse inline markdown into styled segments (bold / italic / code / links / strikethrough). */
function inline(s: string): { segments: StyledSegment[]; text: string } {
  const segments: StyledSegment[] = [];
  // Tokenize by simple regex passes. Order matters: bold before italic so **x** is not eaten by *.
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]*\)|~~[^~]+~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const pre = s.slice(last, m.index);
    if (pre) segments.push({ text: pre });
    const tok = m[0];
    if (tok.startsWith('**')) segments.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith('*')) segments.push({ text: tok.slice(1, -1), italic: true });
    else if (tok.startsWith('`')) segments.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith('~~')) segments.push({ text: tok.slice(2, -2), italic: true });
    else {
      // link [label](url)
      const lm = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(tok);
      segments.push({ text: lm ? lm[1]! : tok, link: !!lm });
    }
    last = m.index + tok.length;
  }
  const tail = s.slice(last);
  if (tail) segments.push({ text: tail });
  return { segments, text: segments.map((x) => x.text).join('') };
}

/**
 * Split a markdown table row into cells.
 * - Handles rows missing the leading or trailing pipe (common LLM output).
 * - Handles escaped pipes inside cells (`\|` renders as a literal |).
 */
function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Does this line look like a table data row?
 * A strict row starts AND ends with | (the usual header form). While we are inside a
 * table block, we also accept rows that omit one of the pipes so LLM sloppiness
 * (`| a | b` or `a | b |`) does not break alignment.
 */
function looksLikeTableRow(line: string, inTable: boolean): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  if (TABLE_SEP_RE.test(t)) return false;
  if (/^\|.*\|\s*$/.test(t)) return true; // strict: both pipes present
  return inTable; // lenient: only inside an already-started table
}

/** Align a markdown table block (rows of cells) to the widest column; returns plain text lines. */
function alignTable(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => dlen(r[c] ?? ''))));
  const pad = (cell: string, w: number) => cell + ' '.repeat(Math.max(0, w - dlen(cell)));
  const fmtRow = (r: string[]) => '│ ' + Array.from({ length: cols }, (_, c) => pad(r[c] ?? '', widths[c]!)).join(' │ ') + ' │';
  const sep = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const bot = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const out = [top, fmtRow(rows[0]!)];
  if (rows.length > 1) out.push(sep);
  for (let i = 1; i < rows.length; i++) out.push(fmtRow(rows[i]!));
  out.push(bot);
  return out;
}

export function renderMarkdown(md: string): StyledLine[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: StyledLine[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let tableBuf: string[][] = [];
  let prevWasTable = false;

  const flushCode = () => {
    if (codeBuf.length > 0) {
      out.push({ kind: 'code', text: codeBuf.join('\n'), codeLang });
      codeBuf = [];
    }
  };

  const flushTable = () => {
    if (tableBuf.length > 0) {
      for (const l of alignTable(tableBuf)) {
        out.push({ kind: 'text', text: l });
      }
      tableBuf = [];
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (!inCode && CODE_BLOCK_RE.test(line)) {
      flushCode();
      flushTable();
      inCode = true;
      codeLang = CODE_BLOCK_RE.exec(line)?.[1] ?? '';
      continue;
    }
    if (inCode) {
      if (/^```\s*$/.test(line)) {
        flushCode();
        inCode = false;
        codeLang = '';
        continue;
      }
      codeBuf.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushTable();
      out.push({ kind: 'empty', text: '' });
      prevWasTable = false;
      continue;
    }
    // Markdown table: accumulate consecutive | rows (skipping the |---| separator).
    // A strict |a|b| header starts the table; inside the block we tolerate sloppy rows
    // (missing leading/trailing pipe) so LLM output stays aligned.
    const strictTableRow = /^\|.*\|\s*$/.test(trimmed) && !TABLE_SEP_RE.test(trimmed);
    if (strictTableRow || (prevWasTable && looksLikeTableRow(trimmed, true))) {
      tableBuf.push(splitRow(trimmed));
      prevWasTable = true;
      continue;
    }
    if (prevWasTable && TABLE_SEP_RE.test(trimmed)) continue; // separator row
    flushTable();
    prevWasTable = false;

    if (/^#{1,6}\s/.test(trimmed)) {
      const level = /^(#{1,6})/.exec(trimmed)![1]!.length;
      const kind = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
      const parsed = inline(trimmed.replace(/^#{1,6}\s*/, ''));
      out.push({ kind, text: parsed.text, segments: parsed.segments });
      continue;
    }
    if (/^```/.test(trimmed)) continue; // defensive
    if (/^>\s?/.test(trimmed)) {
      const parsed = inline(trimmed.replace(/^>\s?/, ''));
      out.push({ kind: 'quote', text: parsed.text, segments: parsed.segments });
      continue;
    }
    const task = TASK_RE.exec(trimmed);
    if (task) {
      const checked = task[1]!.toLowerCase() === 'x';
      const parsed = inline(task[2]!);
      out.push({ kind: 'list', text: `${checked ? '☑' : '☐'} ${parsed.text}`, segments: parsed.segments, task: true, checked });
      continue;
    }
    if (/^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
      const parsed = inline(trimmed.replace(/^([-*+]|\d+[.)])\s/, '• '));
      out.push({ kind: 'list', text: parsed.text, segments: parsed.segments });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push({ kind: 'hr', text: '─'.repeat(40) });
      continue;
    }
    const parsed = inline(trimmed);
    out.push({ kind: 'text', text: parsed.text, segments: parsed.segments });
  }
  flushCode();
  flushTable();
  if (inCode) out.push({ kind: 'code', text: codeBuf.join('\n'), codeLang });
  return out;
}

/** Plain text output for the terminal (used by the --print message view) */
export function markdownToPlain(md: string): string {
  return renderMarkdown(md)
    .filter((l) => l.kind !== 'empty')
    .map((l) => {
      switch (l.kind) {
        case 'h1':
          return `# ${l.text}`;
        case 'h2':
          return `## ${l.text}`;
        case 'h3':
          return `### ${l.text}`;
        case 'code':
          return `\`\`\`${l.codeLang ?? ''}\n${l.text}\n\`\`\``;
        case 'list':
          return l.text;
        case 'quote':
          return `> ${l.text}`;
        case 'hr':
          return '─'.repeat(40);
        default:
          return l.text;
      }
    })
    .join('\n');
}

/** Display width of a string (CJK/fullwidth/emoji count as 2 columns). */
function displayWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    w += charWidth(ch);
    i += ch.length;
  }
  return w;
}

/**
 * Clip a string to a max DISPLAY width (terminal columns), not code points: CJK/fullwidth
 * characters count as 2 columns, so clipping by string length truncates Chinese text one
 * column short and overflows the line. An exact-fit string is returned whole; an overflowing
 * one is cut to fit maxColumns-1 and gets a trailing '…' (total NEVER exceeds maxColumns —
 * this is a rendering protection, overflow is the failure mode it exists to prevent).
 */
export function clipByWidth(text: string, maxColumns: number): string {
  if (maxColumns <= 0) return '';
  if (displayWidth(text) <= maxColumns) return text;
  let w = 0;
  let i = 0;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const cw = charWidth(ch);
    if (w + cw > maxColumns - 1) break; // reserve one column for '…'
    w += cw;
    i += ch.length;
  }
  return text.slice(0, i) + '…';
}

/** Truncate long lines (rendering protection) — by display width (CJK-safe). */
export function clipLine(text: string, maxWidth: number): string {
  return clipByWidth(text, maxWidth);
}
