import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../tools/types.js';
import type { MemoryDb } from './db.js';
import type { MemoryPipeline } from './pipeline.js';
import { memoryTypes, type MemoryType } from '../config/types.js';

const memorySaveSchema = z.object({
  type: z.enum(memoryTypes),
  content: z.string().min(5).max(20_000),
  scope: z.enum(['global', 'project']).optional(),
  importance: z.number().min(0).max(1).optional(),
});

const memorySearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

const memoryListSchema = z.object({
  type: z.enum(memoryTypes).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const memoryForgetSchema = z.object({
  id: z.number().int().positive(),
});

interface MemoryToolOptions {
  db: MemoryDb;
  pipeline: MemoryPipeline;
  workspace: string;
}

export function makeMemoryTools(opts: MemoryToolOptions): ToolDef[] {
  const db = opts.db;

  const save: ToolDef = {
    name: 'memory_save',
    description: 'Save a long-term memory (user preference / project fact / lesson learned). Proactively save important information; it persists across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...memoryTypes] },
        content: { type: 'string', description: 'Memory content (a concise, complete sentence)' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'Scope (default project)' },
        importance: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['type', 'content'],
    },
    permission: 'read',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = memorySaveSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `memory_save invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const entry = db.save({ ...parsed.data, sessionId: ctx.sessionId });
      ctx.emit({ type: 'memory-saved', entries: [{ type: entry.type, content: entry.content }] });
      return { content: `Saved memory #${entry.id} [${entry.type}] ${entry.summary}` };
    },
  };

  const search: ToolDef = {
    name: 'memory_search',
    description: 'Search historical memories (user preferences / project facts / experiences). Call it before acting to confirm past conventions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
    },
    permission: 'read',
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = memorySearchSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `memory_search invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const entries = db.search(parsed.data.query, { limit: parsed.data.limit ?? 5 });
      for (const e of entries) db.touch(e.id);
      if (entries.length === 0) return { content: `No relevant memories: ${parsed.data.query}` };
      return {
        content: `Relevant memories (${entries.length}):\n` +
          entries
            .map((e) => `#${e.id} [${e.type}/${e.scope}] ${e.summary}${e.score ? ` (relevance ${e.score.toFixed(2)})` : ''}`)
            .join('\n'),
      };
    },
  };

  const list: ToolDef = {
    name: 'memory_list',
    description: 'List saved memories (optionally filtered by type).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...memoryTypes] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    permission: 'read',
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = memoryListSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return { content: `memory_list invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const entries = db.list({ type: parsed.data.type as MemoryType | undefined, limit: parsed.data.limit ?? 50 });
      if (entries.length === 0) return { content: '(no memories)' };
      return {
        content: `Memories (${entries.length}):\n` +
          entries.map((e) => `#${e.id} [${e.type}/${e.scope}] ${e.summary}`).join('\n'),
      };
    },
  };

  const forget: ToolDef = {
    name: 'memory_forget',
    description: 'Delete a memory (by id, see memory_list).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Memory id' } },
      required: ['id'],
    },
    permission: 'read',
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = memoryForgetSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `memory_forget invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const ok = db.remove(parsed.data.id);
      return ok ? { content: `Deleted memory #${parsed.data.id}` } : { content: `Memory #${parsed.data.id} not found`, isError: true };
    },
  };

  return [save, search, list, forget];
}
