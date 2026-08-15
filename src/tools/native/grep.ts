import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import ignore from 'ignore';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';
import { globToRegExp, loadIgnoreRules } from './glob.js';

export const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  include: z.string().optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
  caseSensitive: z.boolean().optional(),
});

const MAX_RESULTS = 100;
const MAX_FILE_CHARS = 512 * 1024; // Skip overly large files

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function makeGrepTool(workspace: string): ToolDef {
  return {
    name: 'grep',
    description: 'Search files with a regex (prefers ripgrep; falls back to a built-in scan when not installed). Returns file:line:content.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (case-insensitive)' },
        path: { type: 'string', description: 'Search root (defaults to the workspace)' },
        include: { type: 'string', description: 'File glob filter, e.g. *.ts' },
        maxResults: { type: 'integer', minimum: 1, maximum: 1000 },
        caseSensitive: { type: 'boolean' },
      },
      required: ['pattern'],
    },
    permission: 'read',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = grepSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `grep invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { pattern, path, include, maxResults = MAX_RESULTS, caseSensitive } = parsed.data;
      const root = path ? (isAbsolute(path) ? path : resolve(ctx.cwd, path)) : ctx.cwd;

      // Try ripgrep
      const rgResult = await tryRipgrep(root, pattern, include, maxResults, caseSensitive);
      if (rgResult) return rgResult;

      // Fallback: built-in scan
      return scanFallback(root, pattern, include, maxResults, caseSensitive);
    },
  };
}

async function tryRipgrep(
  root: string,
  pattern: string,
  include: string | undefined,
  maxResults: number,
  caseSensitive: boolean | undefined,
): Promise<ToolResult | null> {
  return new Promise((resolvePromise) => {
    const args = ['--line-number', '--no-heading', '--color', 'never', '-m', String(maxResults)];
    if (!caseSensitive) args.push('-i');
    if (include) args.push('-g', include);
    args.push(pattern, root);
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise(null);
    }, 15_000);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      if (out.length > 100_000) child.kill();
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise(null); // rg not installed
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === null) {
        resolvePromise(null);
        return;
      }
      const lines = out.split('\n').filter(Boolean).slice(0, maxResults);
      if (lines.length === 0) {
        resolvePromise({ content: `No matches for: ${pattern}` });
        return;
      }
      const rel = (p: string) => p.replace(root + sep, '').replace(/\\/g, '/');
      const content = lines
        .map((l) => {
          const idx = l.indexOf(':');
          if (idx === -1) return l;
          return `${rel(l.slice(0, idx))}${l.slice(idx)}`;
        })
        .join('\n');
      resolvePromise({ content: `Matches for ${pattern} (${lines.length}${out.split('\n').filter(Boolean).length > maxResults ? '+' : ''}):\n${content}` });
    });
  });
}

async function scanFallback(
  root: string,
  pattern: string,
  include: string | undefined,
  maxResults: number,
  caseSensitive: boolean | undefined,
): Promise<ToolResult> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    return { content: `Invalid regex: ${pattern}`, isError: true };
  }
  const includeRe = include ? globToRegExp(include) : null;
  const ig = ignore();
  loadIgnoreRules(root, ig);
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0 && results.length < maxResults) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (rel && ig.ignores(rel)) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.deepcode') continue;
        stack.push(abs);
        continue;
      }
      if (includeRe && !includeRe.test(rel)) continue;
      try {
        const st = await stat(abs);
        if (!st.isFile() || st.size > MAX_FILE_CHARS) continue;
        const text = await readFile(abs, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (re.test(lines[i] ?? '')) {
            results.push(`${rel}:${i + 1}: ${(lines[i] ?? '').trim().slice(0, 200)}`);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
  if (results.length === 0) return { content: `No matches for: ${pattern}` };
  return { content: `Matches for ${pattern} (${results.length}):\n${results.join('\n')}` };
}
