import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';

const MAX_CHARS = 60_000;
const MAX_LINES = 4000;

const readFileSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_LINES).optional(),
});

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.exe', '.dll', '.so', '.dylib',
  '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.db', '.sqlite', '.pyc', '.class',
]);

function isBinary(path: string): boolean {
  return BINARY_EXTS.has(extname(path).toLowerCase());
}

export function makeReadFileTool(workspace: string): ToolDef {
  return {
    name: 'read_file',
    description: 'Read file content (with line numbers); paginate with offset/limit. Use to inspect source code, config, and docs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to the workspace or absolute)' },
        offset: { type: 'integer', minimum: 0, description: 'Start line number (0-based), default 0' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LINES, description: `Maximum lines to read, default ${MAX_LINES}` },
      },
      required: ['path'],
    },
    permission: 'read',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = readFileSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `read_file invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { path, offset = 0, limit = MAX_LINES } = parsed.data;
      const abs = resolve(ctx.cwd, path);
      try {
        if (isBinary(abs)) {
          return { content: `File ${path} is binary and cannot be read as text (try run_terminal_cmd instead)`, isError: true };
        }
        const st = await stat(abs);
        if (st.size > 5 * 1024 * 1024) {
          return { content: `File ${path} is too large (${Math.round(st.size / 1024 / 1024)}MB); exceeds the 5MB limit`, isError: true };
        }
        const raw = await readFile(abs, 'utf8');
        const lines = raw.split('\n');
        const slice = lines.slice(offset, offset + limit);
        const numbered = slice.map((line, i) => `${String(offset + i + 1).padStart(5)} | ${line}`).join('\n');
        const truncated = offset + limit < lines.length;
        const head = `📄 ${path} (${lines.length} lines total)\n`;
        let content = head + numbered;
        if (truncated) {
          content += `\n… (${lines.length} lines total, showing ${slice.length}; continue with offset=${offset + slice.length})`;
        }
        if (content.length > MAX_CHARS) {
          content = content.slice(0, MAX_CHARS) + `\n… (content truncated to ${MAX_CHARS} chars)`;
        }
        return { content, artifacts: [{ path: abs }] };
      } catch (e) {
        return { content: `Failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };
}
