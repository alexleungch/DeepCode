import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const todoWriteSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'completed']).optional(),
    }),
  ),
});

/** Session-level todo list (in-memory, persisted with the session). */
export class TodoStore {
  private items: TodoItem[] = [];

  replace(items: TodoItem[]): void {
    this.items = items.map((i) => ({ ...i, status: i.status ?? 'pending' }));
  }

  get(): TodoItem[] {
    return [...this.items];
  }

  /** For session persistence. */
  snapshot(): TodoItem[] {
    return this.get();
  }

  /** For session restore. */
  restore(items: TodoItem[]): void {
    this.items = items.map((i) => ({ ...i, status: i.status ?? 'pending' }));
  }
}

export function makeTodoTool(store: TodoStore): ToolDef {
  return {
    name: 'todo_write',
    description: 'Maintain the todo list for the current task (full replacement). Use it to track progress on multi-step tasks; update statuses when done.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete todo list (submit all entries on every call)',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    },
    permission: 'read',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = todoWriteSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `todo_write invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      store.replace(parsed.data.todos as TodoItem[]);
      const items = store.get();
      // Keep the TUI's live todo panel in sync with the session store.
      ctx.emit({ type: 'todo-updated', todos: items });
      const summary = items
        .map((i, n) => `${n + 1}. [${i.status === 'completed' ? 'x' : i.status === 'in_progress' ? '>' : ' '}] ${i.content}`)
        .join('\n');
      return { content: `Todo list updated (${items.length} items):\n${summary}` };
    },
  };
}
