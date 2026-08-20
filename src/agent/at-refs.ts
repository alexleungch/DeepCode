/**
 * `@file` reference expansion (Claude-Code style).
 *
 * A user message like:
 *
 *     Fix the bug in @src/parser.ts and @src/utils/*.ts
 *
 * is sent to the model with the referenced file contents appended as explicit
 * `<context>` blocks (the display text keeps the `@refs` exactly as typed):
 *
 *     Fix the bug in @src/parser.ts and @src/utils/*.ts
 *
 *     <context>
 *     <path>src/parser.ts</path>
 *     <content>
 *     …file content…
 *     </content>
 *     </context>
 *
 * Supported:
 *   - plain relative paths (resolved against the workspace cwd), absolute paths, `~/…`
 *   - glob patterns with `*`, `?` and `**` (matched files are each attached)
 *   - per-file size cap + a total budget per message, and a binary-file guard
 *
 * A ref that cannot be resolved is appended as an `<error>` block so the model can
 * see and report it — but only when the token actually looks like a file path, so
 * prose/npm-scope/decorator usages (`@types`, `@scope/pkg`) are left untouched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

export interface AtRefReport {
  /** The @-token exactly as typed, e.g. `@src/index.ts` */
  raw: string;
  /** Resolved paths actually read (one per matched file) */
  paths: string[];
  /** true when every matched path was read successfully */
  ok: boolean;
  /** Human-readable error when the ref could not be read */
  error?: string;
  /** Total lines read across matched files */
  lines?: number;
  /** Total chars read (before truncation) */
  chars?: number;
}

export interface AtRefExpansion {
  /** The original input, unchanged */
  text: string;
  /** Original text + appended `<context>` blocks (this is what the model receives) */
  expanded: string;
  /** Per-ref reports (for tests / diagnostics) */
  refs: AtRefReport[];
}

/** Per-file content cap (chars) */
export const MAX_FILE_CHARS = 200_000;
/** Total content budget across ALL refs in a single message (chars) */
export const MAX_TOTAL_CHARS = 400_000;
/** Max files matched by a single glob ref */
export const MAX_GLOB_MATCHES = 20;
/** Byte-size guard before reading (a huge file is rejected, not slurped) */
export const MAX_FILE_BYTES = 1_000_000;

/** A `@path` token: `@` preceded by start/whitespace/`(` `[` `{` `,`, followed by
 *  non-space non-quote non-bracket chars. Deliberately excludes `) ] } " ' \` , ; ! ?`
 *  so trailing punctuation in prose (`(@file)`) does not corrupt the path. */
const AT_TOKEN_RE = /(?<=^|[\s(\[{,])@([^\s"'`$()\[\]{},;!?]+)/g;

/** Does the token look like a file path (vs. a bare word like `@types`)? */
function looksLikePath(token: string): boolean {
  return token.includes('/') || token.includes('\\') || token.includes('.') || token.startsWith('~') || path.isAbsolute(token);
}

/** Resolve `~` / `~/…` to the home directory. */
function expandTilde(p: string, cwd: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  if (p.startsWith('~')) return path.join(homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** Split a glob TOKEN into a walk base + segments (keeps `**` segments intact). */
function splitGlob(token: string, cwd: string): { base: string; segments: string[] } {
  const cleaned = token.replace(/[\\/]+/g, '/');
  if (cleaned.startsWith('~/')) return { base: homedir(), segments: cleaned.slice(2).split('/').filter(Boolean) };
  if (cleaned.startsWith('/')) return { base: '/', segments: cleaned.slice(1).split('/').filter(Boolean) };
  if (/^[A-Za-z]:\//.test(cleaned)) return { base: cleaned.slice(0, 3), segments: cleaned.slice(3).split('/').filter(Boolean) }; // Windows drive
  return { base: cwd, segments: cleaned.split('/').filter(Boolean) };
}

/** Escape a glob segment into a regex (only `*` and `?` are wildcards). */
function segmentRegex(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Minimal glob walker: resolves `segments` against `dir` and collects matching
 * FILE paths (directories are only traversed, never collected). Supports `*`,
 * `?` and `**` in any segment. `**` matches zero or more directory levels.
 */
function globWalk(dir: string, segments: string[], out: string[], depth = 0): void {
  if (out.length >= MAX_GLOB_MATCHES || depth > 32) return;
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (head === '**') {
    // Zero levels consumed: match the rest against dir itself.
    globWalk(dir, rest, out, depth + 1);
    // One or more levels consumed: descend into each entry.
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) globWalk(full, segments, out, depth + 1);
    }
    return;
  }
  if (rest.length === 0) {
    // Terminal segment: collect matching files.
    for (const entry of safeReaddir(dir)) {
      if (out.length >= MAX_GLOB_MATCHES) return;
      if (!segmentRegex(head).test(entry)) continue;
      const full = path.join(dir, entry);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (st?.isFile()) out.push(full);
    }
    return;
  }
  // Intermediate segment: descend into matching directories.
  for (const entry of safeReaddir(dir)) {
    if (!segmentRegex(head).test(entry)) continue;
    const full = path.join(dir, entry);
    if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) globWalk(full, rest, out, depth + 1);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
  } catch {
    return [];
  }
}

function hasGlobChars(p: string): boolean {
  return p.includes('*') || p.includes('?');
}

/** Read one file with caps + binary guard. Returns {ok, error?, content?, lines?}. */
function readFileCapped(absolute: string, budget: { used: number }): { ok: boolean; error?: string; content?: string; lines?: number } {
  try {
    const st = fs.statSync(absolute);
    if (!st.isFile()) return { ok: false, error: `not a file (${st.isDirectory() ? 'is a directory' : 'not a regular file'})` };
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: `file too large (${formatBytes(st.size)} > ${formatBytes(MAX_FILE_BYTES)} cap)` };
    if (st.size === 0) return { ok: true, content: '', lines: 0 };
    // Binary guard: peek the head for NUL bytes before reading the whole file.
    const fd = fs.openSync(absolute, 'r');
    try {
      const head = Buffer.alloc(Math.min(8192, st.size));
      fs.readSync(fd, head, 0, head.length, 0);
      if (head.includes(0)) return { ok: false, error: 'binary file skipped' };
    } finally {
      fs.closeSync(fd);
    }
    let content = fs.readFileSync(absolute, 'utf8');
    const chars = [...content].length;
    if (chars > MAX_FILE_CHARS) content = [...content].slice(0, MAX_FILE_CHARS).join('') + `\n… (truncated at ${MAX_FILE_CHARS} chars)`;
    if (budget.used + chars > MAX_TOTAL_CHARS) return { ok: false, error: 'skipped — total reference budget exceeded' };
    budget.used += chars;
    const lines = content.split('\n').length;
    return { ok: true, content, lines };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

function formatBytes(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`;
}

/** Relative display path (relative when under cwd, absolute otherwise). */
function displayPath(absolute: string, cwd: string): string {
  const rel = path.relative(cwd, absolute);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return absolute;
}

/**
 * Expand `@ref` tokens in `input` (see module docs). Pure-ish: reads the filesystem,
 * but never mutates anything. When there are no refs, `expanded === text`.
 */
export function expandAtRefs(input: string, cwd: string): AtRefExpansion {
  const tokens: string[] = [];
  for (const m of input.matchAll(AT_TOKEN_RE)) {
    const t = m[1]!;
    if (!tokens.includes(t)) tokens.push(t);
  }
  if (tokens.length === 0) return { text: input, expanded: input, refs: [] };

  const budget = { used: 0 };
  const blocks: string[] = [];
  const refs: AtRefReport[] = [];
  for (const token of tokens) {
    const raw = '@' + token;
    const resolved = expandTilde(token, cwd);
    const report: AtRefReport = { raw, paths: [], ok: false };

    let files: string[] = [];
    if (hasGlobChars(token)) {
      const { base, segments } = splitGlob(token, cwd);
      globWalk(base, segments, files);
    } else if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      files = [resolved];
    }

    if (files.length === 0) {
      const exists = fs.existsSync(resolved); // a directory (or a non-file) explicitly referenced
      const err = exists ? 'is a directory' : 'not found';
      report.error = err;
      if (exists || looksLikePath(token)) {
        blocks.push(`<context>\n<path>${raw}</path>\n<error>${err}</error>\n</context>`);
      }
      refs.push(report);
      continue;
    }

    for (const f of files) {
      const r = readFileCapped(f, budget);
      if (r.ok && r.content !== undefined) {
        report.paths.push(f);
        report.lines = (report.lines ?? 0) + (r.lines ?? 0);
        report.chars = (report.chars ?? 0) + r.content.length;
        blocks.push(`<context>\n<path>${displayPath(f, cwd)}</path>\n<content>\n${r.content}\n</content>\n</context>`);
      } else {
        report.error = r.error ?? 'unreadable';
        // Report failures only when the ref really is a path (or it existed on disk),
        // so prose usages like `@types` or `@scope/pkg` never pollute the prompt.
        if (report.paths.length === 0 && (fs.existsSync(resolved) || looksLikePath(token))) {
          blocks.push(`<context>\n<path>${raw}</path>\n<error>${r.error}</error>\n</context>`);
        }
      }
    }
    report.ok = report.paths.length > 0 && report.error === undefined;
    refs.push(report);
  }

  const suffix = blocks.length > 0 ? '\n\n' + blocks.join('\n\n') : '';
  return { text: input, expanded: input + suffix, refs };
}
