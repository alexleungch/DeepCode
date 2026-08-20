import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandAtRefs,
  MAX_FILE_CHARS,
  MAX_GLOB_MATCHES,
  type AtRefReport,
} from '../src/agent/at-refs.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'at-refs-'));
  mkdirSync(join(ws, 'src', 'utils'), { recursive: true });
  writeFileSync(join(ws, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(ws, 'src', 'utils', 'parse.ts'), 'export function parse() {}\n', 'utf8');
  writeFileSync(join(ws, 'notes.md'), '# Notes\n\nplain text\n', 'utf8');
});

afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function firstBlock(expanded: string): string {
  const i = expanded.indexOf('<context>');
  return i >= 0 ? expanded.slice(i, expanded.indexOf('</context>') + '</context>'.length) : '';
}

describe('expandAtRefs', () => {
  it('leaves messages without @refs untouched', () => {
    const r = expandAtRefs('hello world, fix the bug', ws);
    expect(r.expanded).toBe('hello world, fix the bug');
    expect(r.refs).toEqual([]);
  });

  it('appends the file content as a <context> block, keeping the display text as typed', () => {
    const r = expandAtRefs('fix @src/index.ts please', ws);
    expect(r.text).toBe('fix @src/index.ts please');
    expect(r.expanded.startsWith('fix @src/index.ts please')).toBe(true);
    const block = firstBlock(r.expanded);
    expect(block).toContain('<path>src/index.ts</path>');
    expect(block).toContain('<content>');
    expect(block).toContain('export const a = 1;');
    expect(r.refs).toHaveLength(1);
    expect(r.refs[0]).toMatchObject({ raw: '@src/index.ts', ok: true, paths: [join(ws, 'src', 'index.ts')] });
  });

  it('supports absolute paths and ~/ paths', () => {
    const abs = expandAtRefs(`see @${join(ws, 'notes.md')}`, ws);
    expect(abs.refs[0]?.ok).toBe(true);
    const tilde = expandAtRefs('see @~/does-not-exist-xyz.md', ws);
    expect(tilde.refs[0]?.ok).toBe(false);
    expect(tilde.refs[0]?.error).toBe('not found');
  });

  it('expands every match of a glob, each as its own <context> block', () => {
    const r = expandAtRefs('fix @src/**/*.ts', ws);
    expect(r.refs).toHaveLength(1);
    expect(r.refs[0]?.ok).toBe(true);
    expect(r.refs[0]?.paths).toHaveLength(2);
    const blocks = r.expanded.match(/<context>/g) ?? [];
    expect(blocks).toHaveLength(2);
    expect(r.expanded).toContain('<path>src/index.ts</path>');
    expect(r.expanded).toContain('<path>src/utils/parse.ts</path>');
  });

  it('reports a missing path-looking ref as an <error> block', () => {
    const r = expandAtRefs('see @src/nope.ts and @missing/dir.txt', ws);
    expect(r.refs.every((x) => !x.ok)).toBe(true);
    const blocks = r.expanded.match(/<error>/g) ?? [];
    expect(blocks).toHaveLength(2);
    expect(r.expanded).toContain('<path>@src/nope.ts</path>');
    expect(r.expanded).toContain('not found');
  });

  it('reports an explicitly-referenced directory as an error', () => {
    const r = expandAtRefs('read @src', ws);
    expect(r.refs[0]?.ok).toBe(false);
    expect(r.expanded).toContain('is a directory');
  });

  it('does NOT expand bare words like @types (prose/npm-scope safety)', () => {
    const r = expandAtRefs('use @types and @decorator here', ws);
    expect(r.expanded).toBe('use @types and @decorator here');
    // tokens are parsed but never produce <context>/<error> blocks (not path-looking)
    expect(r.refs).toHaveLength(2);
    expect(r.refs.every((x) => !x.ok && x.error === 'not found')).toBe(true);
    expect(r.expanded).not.toContain('<context>');
  });

  it('does not expand an @ inside a word (email-like)', () => {
    const r = expandAtRefs('contact me@example.com now', ws);
    expect(r.expanded).toBe('contact me@example.com now');
    expect(r.refs).toEqual([]);
  });

  it('dedupes repeated references of the same token', () => {
    const r = expandAtRefs('a @src/index.ts then @src/index.ts again', ws);
    expect(r.refs).toHaveLength(1);
    const blocks = r.expanded.match(/<context>/g) ?? [];
    expect(blocks).toHaveLength(1);
  });

  it('skips binary files', () => {
    const bin = join(ws, 'blob.bin');
    writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const r = expandAtRefs('see @blob.bin', ws);
    expect(r.refs[0]?.ok).toBe(false);
    expect(r.refs[0]?.error).toBe('binary file skipped');
  });

  it('truncates oversized files with a marker', () => {
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(MAX_FILE_CHARS + 1000), 'utf8');
    const r = expandAtRefs('see @big.txt', ws);
    expect(r.refs[0]?.ok).toBe(true);
    expect(r.expanded).toContain('truncated at');
  });

  it('caps the number of glob matches', () => {
    for (let i = 0; i < MAX_GLOB_MATCHES + 5; i++) writeFileSync(join(ws, `src/f${i}.ts`), `// ${i}\n`, 'utf8');
    const r = expandAtRefs('all @src/*.ts', ws);
    const paths = r.refs[0]?.paths ?? [];
    expect(paths.length).toBeLessThanOrEqual(MAX_GLOB_MATCHES);
    expect(paths.length).toBeGreaterThan(0);
  });

  it('reports per-ref metadata (lines/chars)', () => {
    const r = expandAtRefs('@notes.md', ws);
    const rep: AtRefReport = r.refs[0]!;
    expect(rep.lines).toBe(4); // '# Notes', '', 'plain text', trailing ''
    expect(rep.chars).toBeGreaterThan(0);
  });
});
