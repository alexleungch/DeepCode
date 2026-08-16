import { readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import ignore from 'ignore';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';

const globSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(2000).optional(),
});

const MAX_RESULTS = 500;

/** Simplified glob → RegExp: supports **, *, ?, {a,b}. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  const chars = glob;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '*') {
      if (chars[i + 1] === '*') {
        // ** crosses directory separators
        re += '.*';
        i += 2;
        if (chars[i] === '/') i++; // Consume the following /
        continue;
      }
      re += '[^/\\\\]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/\\\\]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = chars.indexOf('}', i);
      if (end > i) {
        const alts = chars
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end + 1;
        continue;
      }
    }
    re += (c ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** Recursively scan the directory tree (skipping .git/node_modules/dist and ignore rules). */
export async function walkTree(root: string, ig: ReturnType<typeof ignore>): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (rel && ig.ignores(rel)) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.deepcode') continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }
  return results.sort();
}

export function loadIgnoreRules(root: string, ig: ReturnType<typeof ignore>): void {
  // .gitignore and .deepcode/ignore (if present)
  for (const file of ['.gitignore', '.deepcode/ignore']) {
    try {
      const content = readFileSync(join(root, file), 'utf8');
      ig.add(content.split('\n').filter((l) => l.trim() && !l.startsWith('#')));
    } catch {
      // File does not exist
    }
  }
}

export function makeGlobTool(workspace: string): ToolDef {
  return {
    name: 'glob',
    description: 'Find files by glob pattern (supports **, *, ?, {a,b}), automatically skipping .gitignore, node_modules, .git, .deepcode.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts, src/**, *.{ts,tsx}' },
        path: { type: 'string', description: 'Search root directory (defaults to the workspace)' },
        maxResults: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      required: ['pattern'],
    },
    permission: 'read',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = globSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `glob invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { pattern, path, maxResults = MAX_RESULTS } = parsed.data;
      const root = path ? (isAbsolute(path) ? path : resolve(ctx.cwd, path)) : ctx.cwd;
      let st;
      try {
        st = await stat(root);
      } catch {
        return { content: `Directory does not exist: ${path ?? workspace}`, isError: true };
      }
      if (!st.isDirectory()) {
        return { content: `glob path is not a directory: ${path ?? ctx.cwd}`, isError: true };
      }
      const re = globToRegExp(pattern);
      const ig = ignore();
      loadIgnoreRules(root, ig);
      const files = await walkTree(root, ig);
      const matched = files.filter((f) => re.test(f)).slice(0, maxResults);
      const truncated = files.filter((f) => re.test(f)).length > maxResults;
      if (matched.length === 0) {
        return { content: `No matches for: ${pattern} (${root})` };
      }
      const content = matched.map((f) => f).join('\n') + (truncated ? `\n… (exceeds ${maxResults} results, truncated)` : '');
      return { content: `Matches for ${pattern} (${matched.length} files${truncated ? '+, truncated' : ''}):\n${content}` };
    },
  };
}
