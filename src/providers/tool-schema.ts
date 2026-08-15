import type { ToolSchema } from './types.js';

/** Name pattern for tools (MCP tools, etc.) */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Internal ToolSchema → OpenAI-compatible / Anthropic / Ollama formats.
 * Deterministic key ordering: all schema objects are serialized with keys sorted, keeping the prefix byte-stable (critical for cache hits).
 */

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Recursively sort by key name to get a byte-stable plain data object */
export function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableSort((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function toOpenAiTools(tools: ToolSchema[]): OpenAiTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: stableSort(t.inputSchema) as Record<string, unknown>,
    },
  }));
}

export function toAnthropicTools(tools: ToolSchema[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: stableSort(t.inputSchema) as Record<string, unknown>,
  }));
}

export function toGeminiTools(tools: ToolSchema[]): { functionDeclarations: GeminiFunctionDeclaration[] }[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: stableSort(t.inputSchema) as Record<string, unknown>,
      })),
    },
  ];
}

/** Unified input validation error */
export class ToolInputError extends Error {
  constructor(toolName: string, issues: string[]) {
    super(`Tool ${toolName} argument validation failed: ${issues.join('; ')}`);
    this.name = 'ToolInputError';
  }
}

/** Degradation signal when the model (e.g. Ollama) does not support tools */
export class ToolNotSupportedError extends Error {
  constructor(provider: string, model: string, cause?: unknown) {
    super(`${provider} model ${model} does not support tool calling (degraded to plain-text mode)${cause ? `: ${String(cause)}` : ''}`);
    this.name = 'ToolNotSupportedError';
  }
}
