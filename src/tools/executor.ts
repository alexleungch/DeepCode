import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDef, ToolResult } from './types.js';
import { ToolInputError } from '../providers/tool-schema.js';

/** Execution wrapper for a single tool call (timing/events/error wrapping). */
export class ToolExecutor {
  constructor(private registry: { get(name: string): ToolDef | undefined }) {}

  /** Validate input and execute; returns a structured result without throwing (errors are wrapped as isError).
   *  @param callId  The model's tool_use id (e.g. toolu_…). Reusing it keeps a single tool card across
   *                 the streamed tool-start, this execution, and the tool-result; callers that have no
   *                 such id (e.g. direct tests) get a fresh random one. */
  async execute(name: string, rawInput: unknown, ctx: ToolContext, callId?: string): Promise<ToolResult> {
    const tool = this.registry.get(name);
    const id = callId ?? randomUUID().slice(0, 8);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const started = Date.now();
    ctx.emit({ type: 'tool-start', callId: id, name, input });
    let result: ToolResult;
    try {
      result = await withTimeout(tool.execute(input, ctx), ctx.config.agent.toolTimeoutMs, `Tool ${name} execution timed out (${ctx.config.agent.toolTimeoutMs}ms)`);
    } catch (e) {
      if (e instanceof ToolInputError) {
        result = { content: e.message, isError: true };
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        result = { content: `Tool ${name} was interrupted`, isError: true };
      } else {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        result = { content: `Tool ${name} execution failed: ${msg}`, isError: true };
      }
    }
    const durationMs = Date.now() - started;
    ctx.emit({ type: 'tool-result', callId: id, name, result, durationMs });
    return result;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
