import type { ToolRegistry } from '../registry.js';
import type { ToolDef } from '../types.js';
import { makeReadFileTool } from './read.js';
import { makeEditTools } from './edit.js';
import { makeBashTool } from './bash.js';
import { makeGlobTool } from './glob.js';
import { makeGrepTool } from './grep.js';
import { makeTodoTool, type TodoStore } from './todo.js';
import { makeAskUserTool } from './ask-user.js';

interface NativeToolOptions {
  workspace: string;
  todoStore: TodoStore;
  /** Optional extra tools (browser_review / skill / task / memory, etc. injected by later stages). */
  extra?: ToolDef[];
}

/** Register all native tools (fixed order → stable prefixes). */
export function registerNativeTools(registry: ToolRegistry, opts: NativeToolOptions): void {
  const tools: ToolDef[] = [
    makeReadFileTool(opts.workspace),
    ...makeEditTools(opts.workspace),
    makeBashTool(opts.workspace),
    makeGlobTool(opts.workspace),
    makeGrepTool(opts.workspace),
    makeTodoTool(opts.todoStore),
    makeAskUserTool(),
    ...(opts.extra ?? []),
  ];
  for (const tool of tools) {
    registry.register(tool);
  }
}
