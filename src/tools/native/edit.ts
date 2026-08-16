import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { diffLines } from 'diff';
import type { ToolDef, ToolContext, ToolResult, ToolPreview } from '../types.js';

const MAX_WRITE_CHARS = 200_000;

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const editFileSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

function unifiedDiff(path: string, oldText: string, newText: string): string {
  const parts = diffLines(oldText, newText);
  // Flatten to (mark, line) entries
  const entries: { mark: ' ' | '+' | '-'; line: string }[] = [];
  for (const part of parts) {
    const lines = part.value.split('\n');
    if (part.value.endsWith('\n')) lines.pop();
    if (part.added) for (const l of lines) entries.push({ mark: '+', line: l });
    else if (part.removed) for (const l of lines) entries.push({ mark: '-', line: l });
    else for (const l of lines) entries.push({ mark: ' ', line: l });
  }

  // Group into hunks: change blocks ± 2 lines of leading/trailing context
  const CONTEXT = 2;
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < entries.length) {
    const cur = entries[i];
    if (!cur) break;
    if (cur.mark === ' ') {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    // Find the change block [start, end)
    const start = Math.max(0, i - CONTEXT);
    let j = i;
    while (j < entries.length && entries[j]?.mark !== ' ') j++;
    const end = Math.min(entries.length, j + CONTEXT);
    // Compute hunk start line numbers
    let hOld = oldLine - (i - start);
    let hNew = newLine - (i - start);
    const hunkLines: string[] = [];
    for (let k = start; k < end; k++) {
      const e = entries[k];
      if (!e) continue;
      hunkLines.push(`${e.mark}${e.line}`);
      if (e.mark === ' ') {
        oldLine++;
        newLine++;
      } else if (e.mark === '-') {
        oldLine++;
      } else {
        newLine++;
      }
    }
    hunks.push({ oldStart: Math.max(1, hOld), newStart: Math.max(1, hNew), lines: hunkLines });
    i = end;
  }

  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    const removed = h.lines.filter((l) => l.startsWith('-')).length;
    const added = h.lines.filter((l) => l.startsWith('+')).length;
    out.push(`@@ -${h.oldStart},${removed} +${h.newStart},${added} @@`);
    out.push(...h.lines);
  }
  return out.join('\n');
}

function makeWriteTool(workspace: string): ToolDef {
  return {
    name: 'write_file',
    description: 'Write/overwrite a whole file. Use it to create new files or rewrite large sections; existing files produce a diff for approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to the workspace or absolute)' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
    },
    permission: 'write',
    async preview(input: unknown, ctx: ToolContext): Promise<ToolPreview> {
      const parsed = writeFileSchema.safeParse(input);
      if (!parsed.success) {
        return { description: `write_file (invalid arguments: ${parsed.error.issues[0]?.message ?? ''})` };
      }
      const { path, content } = parsed.data;
      const root = ctx.cwd;
      let diff = `+++ ${path}\n+ (new file, ${content.split('\n').length} lines)`;
      try {
        const old = await readFile(resolve(root, path), 'utf8');
        diff = unifiedDiff(path, old, content);
      } catch {
        // New file
      }
      return { description: `Write file ${path}`, diff, path };
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = writeFileSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `write_file invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { path, content } = parsed.data;
      if (content.length > MAX_WRITE_CHARS) {
        return { content: `Content too long (${content.length} chars, limit ${MAX_WRITE_CHARS}); split it into chunks or use edit_file`, isError: true };
      }
      const abs = resolve(ctx.cwd, path);
      let diff: string | undefined;
      let existed = false;
      try {
        const old = await readFile(abs, 'utf8');
        existed = true;
        diff = unifiedDiff(path, old, content);
      } catch {
        diff = `+++ ${path}\n+ (new file, ${content.split('\n').length} lines)`;
      }
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
      } catch (e) {
        return { content: `Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      const summary = existed ? `${diff?.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length ?? 0} lines added / ${diff?.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length ?? 0} lines deleted` : 'new file created';
      return { content: `Wrote ${path} (${summary})`, diff, artifacts: [{ path: abs }] };
    },
  };
}

function makeEditTool(workspace: string): ToolDef {
  return {
    name: 'edit_file',
    description: 'Precise string-replacement edit: locate a unique snippet with old_string and replace it with new_string. Token-efficient, avoids rewriting the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'The exact text to replace (must match uniquely; include context to disambiguate)' },
        new_string: { type: 'string', description: 'The new text after replacement' },
        replace_all: { type: 'boolean', description: 'When true, replace all matches (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    permission: 'write',
    async preview(input: unknown, ctx: ToolContext): Promise<ToolPreview> {
      const parsed = editFileSchema.safeParse(input);
      if (!parsed.success) {
        return { description: `edit_file (invalid arguments: ${parsed.error.issues[0]?.message ?? ''})` };
      }
      const { path, old_string, new_string, replace_all = false } = parsed.data;
      let diff = `(could not generate diff: file unreadable)`;
      try {
        const old = await readFile(resolve(ctx.cwd, path), 'utf8');
        const newText = replace_all ? old.split(old_string).join(new_string) : old.replace(old_string, new_string);
        diff = unifiedDiff(path, old, newText);
      } catch {
        // Ignore
      }
      return { description: `Edit file ${path}`, diff, path };
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = editFileSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `edit_file invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { path, old_string, new_string, replace_all = false } = parsed.data;
      const abs = resolve(ctx.cwd, path);
      let text: string;
      try {
        text = await readFile(abs, 'utf8');
      } catch (e) {
        return { content: `Failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      const idx = text.indexOf(old_string);
      if (idx === -1) {
        return {
          content: `old_string not found in ${path}. Include more context and retry. Content near the first 60 characters before the target snippet:\n${text.slice(Math.max(0, idx === -1 ? 0 : idx - 60), Math.min(text.length, 200))}`,
          isError: true,
        };
      }
      const count = text.split(old_string).length - 1;
      if (count > 1 && !replace_all) {
        return {
          content: `old_string appears ${count} times in ${path}; widen the context to make it unique, or set replace_all=true`,
          isError: true,
        };
      }
      const newText = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, newText, 'utf8');
      } catch (e) {
        return { content: `Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      return { content: `Edited ${path} (${replace_all ? `${count} replacements` : '1 replacement'})`, diff: unifiedDiff(path, text, newText), artifacts: [{ path: abs }] };
    },
  };
}

export function makeEditTools(workspace: string): ToolDef[] {
  return [makeWriteTool(workspace), makeEditTool(workspace)];
}
