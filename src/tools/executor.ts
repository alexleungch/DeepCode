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
    if (ctx.signal?.aborted) {
      ctx.emit({ type: 'tool-start', callId: id, name, input });
      ctx.emit({ type: 'tool-result', callId: id, name, result: { content: `Tool ${name} was interrupted before it started`, isError: true }, durationMs: 0 });
      return { content: `Tool ${name} was interrupted before it started`, isError: true };
    }
    const started = Date.now();
    ctx.emit({ type: 'tool-start', callId: id, name, input });
    let result: ToolResult;
    try {
      result = await withTimeoutAndSignal(tool.execute(input, ctx), ctx.config.agent.toolTimeoutMs, ctx.signal, `Tool ${name} execution timed out (${ctx.config.agent.toolTimeoutMs}ms)`);
    } catch (e) {
      if (e instanceof ToolInputError) {
        result = { content: e.message, isError: true };
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        result = { content: `Tool ${name} was interrupted`, isError: true };
      } else if (e instanceof Error && e.name === 'ToolInterrupted') {
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

/** Marker error: the tool was abandoned because the turn was interrupted (not a normal failure). */
export class ToolInterruptedError extends Error {
  constructor(message = 'interrupted') {
    super(message);
    this.name = 'ToolInterrupted';
  }
}

async function withTimeoutAndSignal<T>(p: Promise<T>, ms: number, signal: AbortSignal | undefined, message: string): Promise<T> {
  // No timeout configured? still race against the abort signal so interrupt-responsive tools
  // (bash kills the child) resolve promptly instead of letting the turn hang on a long run.
  const timeout = !ms || ms <= 0 ? null : new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
  const abort = signal && !signal.aborted
    ? new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ToolInterruptedError()), { once: true }))
    : null;
  const race: Promise<T>[] = [p];
  if (timeout) race.push(timeout as Promise<never>);
  if (abort) race.push(abort as Promise<never>);
  return Promise.race(race);
}
