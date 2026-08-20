import { describe, it, expect } from 'vitest';
import { clipByWidth, clipLine } from '../src/ui/markdown.js';

describe('clipByWidth (display-column-aware truncation)', () => {
  it('returns short text unchanged', () => {
    expect(clipByWidth('hello', 10)).toBe('hello');
  });

  it('returns an exact-fit string whole (no ellipsis)', () => {
    expect(clipByWidth('hello', 5)).toBe('hello');
  });

  it('clips ASCII overflow and appends an ellipsis', () => {
    // 8 columns: 7 chars + '…' (reserves one column for the ellipsis, never overflows).
    expect(clipByWidth('hello world', 8)).toBe('hello w…');
  });

  it('counts CJK/fullwidth chars as 2 columns (old length-based clip overflowed)', () => {
    // 中文 = 2 columns each → 5 chars occupy 10 columns: fits exactly at 10.
    expect(clipByWidth('中文测试啊', 10)).toBe('中文测试啊');
    // 6 chars = 12 columns > 10 → cut to fit 9 cols + ellipsis (never exceeds maxColumns).
    expect(clipByWidth('中文测试啊啊', 10)).toBe('中文测试…');
    // ASCII + CJK mixed: "ab中文" = 2 + 4 = 6 columns.
    expect(clipByWidth('ab中文', 6)).toBe('ab中文');
    // "ab中文x" = 7 columns > 6 → cut to 5 cols (a,b,中) + ellipsis = 6.
    expect(clipByWidth('ab中文x', 6)).toBe('ab中…');
  });

  it('handles emoji (2 columns) without splitting surrogate pairs', () => {
    // "a😀b" = 1+2+1 = 4 columns: fits at 4, overflows at 3.
    expect(clipByWidth('a😀b', 4)).toBe('a😀b');
    expect(clipByWidth('a😀b', 3)).toBe('a…');
    // "a😀bc" = 5 columns > 4 → clip, keeping the emoji intact.
    expect(clipByWidth('a😀bc', 4)).toBe('a😀…');
  });

  it('clips at maxColumns 0 or negative to empty', () => {
    expect(clipByWidth('abc', 0)).toBe('');
    expect(clipByWidth('abc', -1)).toBe('');
  });

  it('clipLine stays signature-compatible and delegates to clipByWidth', () => {
    expect(clipLine('hello world', 8)).toBe('hello w…');
    expect(clipLine('中文测试啊啊', 10)).toBe('中文测试…');
  });
});
