import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atTokens, atSpanAtCursor, segmentChars, editorReducer } from '../src/ui/components/prompt-text.js';
import { atCandidates } from '../src/ui/at-complete.js';

describe('atTokens (input @-ref tokenization)', () => {
  it('finds word-boundary @refs with 1+ path chars', () => {
    expect(atTokens('fix @src/a.ts now')).toEqual([{ start: 4, end: 13 }]);
  });

  it('ignores @ inside words (emails, decorators mid-token)', () => {
    expect(atTokens('me@example.com')).toEqual([]);
    expect(atTokens('x@y')).toEqual([]);
  });

  it('ignores a trailing bare @ (no path chars)', () => {
    expect(atTokens('see @')).toEqual([]);
  });

  it('does not treat punctuation as part of the path', () => {
    const tokens = atTokens('(@src/a.ts) and {@src/b.ts}, @c.ts;');
    expect(tokens).toEqual([
      { start: 1, end: 10 },
      { start: 17, end: 26 },
      { start: 29, end: 34 },
    ]);
  });
});

describe('atSpanAtCursor', () => {
  it('returns the token under the cursor', () => {
    expect(atSpanAtCursor('fix @src/a.ts now', 8)).toEqual({ start: 4, end: 13, partial: 'src/a.ts' });
    // cursor exactly at the end of the token still completes
    expect(atSpanAtCursor('fix @src/a.ts now', 13)?.partial).toBe('src/a.ts');
    // cursor on the @ itself
    expect(atSpanAtCursor('fix @src/a.ts now', 4)?.partial).toBe('src/a.ts');
  });

  it('offers the top-level listing for a bare trailing @ at a word boundary', () => {
    expect(atSpanAtCursor('see @', 5)).toEqual({ start: 4, end: 5, partial: '' });
  });

  it('returns null away from a ref', () => {
    expect(atSpanAtCursor('fix @src/a.ts now', 2)).toBeNull();
    expect(atSpanAtCursor('hello', 3)).toBeNull();
  });
});

describe('segmentChars (highlight spans)', () => {
  it('splits a row into plain/ref segments', () => {
    const segs = segmentChars([...'fix @a.ts now'], 0, atTokens('fix @a.ts now'));
    expect(segs).toEqual([
      { text: 'fix ', isRef: false },
      { text: '@a.ts', isRef: true },
      { text: ' now', isRef: false },
    ]);
  });

  it('works when the row starts mid-token (wrapped rows carry their own base offset)', () => {
    const value = 'xx @verylongpathfile.ts yy';
    const tokens = atTokens(value);
    // simulate a wrapped row starting at offset 5 (inside the ref)
    const segs = segmentChars([...value].slice(5, 12), 5, tokens);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs[0]?.isRef).toBe(true);
  });
});

describe('editorReducer completeAt', () => {
  it('replaces the @-token with the completed value and moves the cursor', () => {
    // completeAt replaces the WHOLE span including the `@`, so callers pass `@` + value.
    const s = editorReducer({ value: 'fix @sr', cursor: 7, history: [], histIdx: -1 }, { type: 'completeAt', value: '@src/' });
    expect(s.value).toBe('fix @src/');
    expect(s.cursor).toBe(9);
  });

  it('is a no-op when the cursor is not on a ref', () => {
    const before = { value: 'hello', cursor: 2, history: [] as string[], histIdx: -1 };
    expect(editorReducer(before, { type: 'completeAt', value: 'x' })).toEqual(before);
  });
});

describe('atCandidates (filesystem completion)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'at-complete-'));
    mkdirSync(join(ws, 'src', 'utils'), { recursive: true });
    writeFileSync(join(ws, 'src', 'index.ts'), '', 'utf8');
    writeFileSync(join(ws, 'src', 'utils', 'parse.ts'), '', 'utf8');
    writeFileSync(join(ws, 'README.md'), '', 'utf8');
  });

  afterEach(() => {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('lists top-level entries for an empty partial', () => {
    const c = atCandidates('', ws);
    expect(c.some((x) => x.value === 'src' && x.isDir)).toBe(true);
    expect(c.some((x) => x.value === 'README.md' && !x.isDir)).toBe(true);
  });

  it('completes by basename prefix inside a directory', () => {
    const c = atCandidates('src/', ws);
    expect(c.map((x) => x.value)).toContain('src/index.ts');
  });

  it('nested completion keeps the typed dir prefix', () => {
    const c = atCandidates('src/ut', ws);
    expect(c.map((x) => x.value)).toContain('src/utils');
    expect(c.find((x) => x.value === 'src/utils')?.isDir).toBe(true);
  });

  it('returns [] for a missing directory', () => {
    expect(atCandidates('nope/', ws)).toEqual([]);
  });
});
