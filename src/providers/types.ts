import type { ModelMeta, ProviderId } from '../config/types.js';

// ---------- Message model ----------

export interface ContentBlockText {
  type: 'text';
  text: string;
}

export interface ContentBlockImage {
  type: 'image';
  /** MIME type, e.g. image/png */
  mediaType: string;
  base64: string;
}

export interface ContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ContentBlockToolResult {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockToolUse
  | ContentBlockToolResult;

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentBlock[];
}

// ---------- Tools ----------

/** Internal tool schema (JSON Schema draft-07 subset) */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------- Usage ----------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic: cache_read_input_tokens */
  cacheReadTokens?: number;
  /** Anthropic: cache_creation_input_tokens */
  cacheWriteTokens?: number;
  /** DeepSeek: prompt_cache_hit_tokens */
  promptCacheHitTokens?: number;
  /** DeepSeek: prompt_cache_miss_tokens */
  promptCacheMissTokens?: number;
  /** Gemini: cachedContentTokenCount */
  cachedContentTokenCount?: number;
  /** Estimated cost (USD), computed by usage/pricing; providers do not fill this in */
  costUsd?: number;
}

// ---------- Request/response ----------

export interface LLMRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens: number;
  temperature?: number;
  /** Anthropic cache_control breakpoint: index into the messages array (system is -1) */
  cacheBreakpoints?: { index: number; ttlSeconds?: number }[];
  thinkingBudgetTokens?: number;
  signal: AbortSignal;
}

export interface LLMResponse {
  message: ChatMessage;
  usage: Usage;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
}

export type LLMStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string }
  | { type: 'tool-input-delta'; id: string; partialJson: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; response: LLMResponse }
  | { type: 'error'; message: string };

// ---------- Provider interface ----------

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly modelMeta: ModelMeta;
  /** Streaming request; terminates with a done or error event */
  stream(req: LLMRequest): AsyncIterable<LLMStreamEvent>;
  /** Non-streaming fallback */
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ---------- Helper functions ----------

export function textContentOf(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  const parts: string[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') parts.push((b as ContentBlockText).text);
    else if (b.type === 'tool_result') parts.push((b as ContentBlockToolResult).content);
  }
  return parts.join('\n');
}

export function toolResultBlocksOf(msg: ChatMessage): ContentBlockToolResult[] {
  return typeof msg.content === 'string' ? [] : msg.content.filter((b) => b.type === 'tool_result') as ContentBlockToolResult[];
}
