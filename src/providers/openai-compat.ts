import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { DeepcodeConfig, ProviderId } from '../config/types.js';
import { BUILTIN_MODEL_META } from '../config/defaults.js';
import type {
  ChatMessage,
  ContentBlockImage,
  ContentBlockText,
  ContentBlockToolResult,
  ContentBlockToolUse,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ToolSchema,
} from './types.js';
import { toOpenAiTools, stableSort } from './tool-schema.js';

interface OpenAiCompatOptions {
  id: ProviderId;
  label: string;
  /** Default endpoint */
  defaultBaseUrl: string;
  /** Config section: deepseek / grok / openai-compat */
  envKey: string;
}

/** OpenAI-compatible cache_control part (Anthropic-style content block, emulated by gateways that expose cache_control). */
type CacheControlTextPart = { type: 'text'; text: string; cache_control: { type: 'ephemeral' } };

// ---------- JSON tool calling protocol (tool calling polyfill for models without native function calling, e.g. deepseek-reasoner) ----------

/** Whether to enable the JSON tool calling protocol: the model metadata explicitly declares it, or the model name contains "reasoner" */
export function isJsonToolModel(config: DeepcodeConfig, model: string): boolean {
  return config.modelMeta[model]?.toolCallProtocol === 'json' || model.toLowerCase().includes('reasoner');
}

/** Append the tool catalog and JSON output contract at the end of the system prompt (stable prefix: deterministic schema key ordering) */
export function buildJsonToolSystem(system: string, tools: ToolSchema[]): string {
  if (tools.length === 0) return system;
  const catalog = tools
    .map((t) => `- ${t.name}: ${t.description}\n  Parameters Schema: ${JSON.stringify(stableSort(t.inputSchema))}`)
    .join('\n');
  return `${system}

# tool calling protocol (JSON mode)
You can call the following tools:
${catalog}

Calling rules:
- When you need to call a tool, output a single valid JSON object (do not wrap it in a markdown code block, do not output anything else):
  {"tool_calls": [{"name": "<tool name>", "arguments": {arguments object}}]}
- You can list multiple tool calls at once (they are executed in parallel)
- Tool results are provided in the next turn as "[tool result <name>]: <content>"; continue reasoning
- When the answer is complete, output:
  {"response": "<your answer>"}
- Plain-text answers must also be output in the {"response": "..."} form`;
}

export interface ParsedJsonToolCalls {
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  response?: string;
}

/** Extract JSON tool calls from model output (tolerates markdown fences and surrounding noise) */
export function parseJsonToolCalls(raw: string): ParsedJsonToolCalls | null {
  let text = raw.trim();
  // Strip markdown code fence
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text);
  if (fence) text = fence[1]!.trim();
  // Find the first { to the last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const out: ParsedJsonToolCalls = { toolCalls: [] };
  if (typeof o.response === 'string') out.response = o.response;
  if (Array.isArray(o.tool_calls)) {
    for (const tc of o.tool_calls) {
      if (typeof tc !== 'object' || tc === null) continue;
      const t = tc as Record<string, unknown>;
      const name = typeof t.name === 'string' ? t.name : '';
      if (!name) continue;
      let args: Record<string, unknown> = {};
      if (typeof t.arguments === 'string') {
        try {
          args = JSON.parse(t.arguments) as Record<string, unknown>;
        } catch {
          args = { _raw: t.arguments };
        }
      } else if (typeof t.arguments === 'object' && t.arguments !== null) {
        args = t.arguments as Record<string, unknown>;
      }
      out.toolCalls.push({ name, arguments: args });
    }
  }
  if (out.toolCalls.length === 0 && out.response === undefined) return null;
  return out;
}

/** JSON mode message conversion: tool_use → text; tool_result → [tool result <name>] text */
function toJsonModeMessages(req: LLMRequest): ChatCompletionMessageParam[] {
  // Build the toolUseId → tool name mapping (from assistant messages)
  const nameById = new Map<string, string>();
  const out: ChatCompletionMessageParam[] = [];
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : textOf(msg) });
      continue;
    }
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }
      const toolResults = msg.content.filter((b): b is ContentBlockToolResult => b.type === 'tool_result');
      if (toolResults.length > 0) {
        // Textify tool results (the JSON tool calling protocol has no tool_call_id concept)
        const parts = toolResults.map((tr) => {
          const name = nameById.get(tr.toolUseId) ?? 'unknown';
          return `[tool result ${name}]: ${tr.content.slice(0, 30_000)}${tr.isError ? '\n (tool execution failed)' : ''}`;
        });
        out.push({ role: 'user', content: parts.join('\n') });
        continue;
      }
      const hasImage = msg.content.some((b) => b.type === 'image');
      if (hasImage) {
        out.push({
          role: 'user',
          content: msg.content.map((b) => {
            if (b.type === 'image') {
              const img = b as ContentBlockImage;
              return { type: 'image_url' as const, image_url: { url: `data:${img.mediaType};base64,${img.base64}` } };
            }
            return { type: 'text' as const, text: (b as ContentBlockText).text };
          }),
        });
        continue;
      }
      out.push({ role: 'user', content: textOf(msg) });
      continue;
    }
    // assistant
    if (typeof msg.content === 'string') {
      out.push({ role: 'assistant', content: msg.content });
      continue;
    }
    const toolUses = msg.content.filter((b): b is ContentBlockToolUse => b.type === 'tool_use');
    for (const tu of toolUses) nameById.set(tu.id, tu.name);
    const text = textOf(msg);
    const callsText = toolUses
      .map((tu) => `[tool call ${tu.name}]: ${JSON.stringify(tu.input ?? {})}`)
      .join('\n');
    const content = [text, callsText].filter(Boolean).join('\n');
    out.push({ role: 'assistant', content: content || ' ' });
  }
  return out;
}

export function toOpenAiMessages(req: LLMRequest): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : textOf(msg) });
      continue;
    }
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }
      const blocks = msg.content;
      const hasImage = blocks.some((b) => b.type === 'image');
      const toolResults = blocks.filter((b): b is ContentBlockToolResult => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({ role: 'tool', tool_call_id: tr.toolUseId, content: tr.content });
        }
        continue;
      }
      if (hasImage) {
        out.push({
          role: 'user',
          content: blocks.map((b) => {
            if (b.type === 'image') {
              const img = b as ContentBlockImage;
              return { type: 'image_url' as const, image_url: { url: `data:${img.mediaType};base64,${img.base64}` } };
            }
            return { type: 'text' as const, text: (b as ContentBlockText).text };
          }),
        });
        continue;
      }
      out.push({ role: 'user', content: textOf(msg) });
      continue;
    }
    // assistant
    if (typeof msg.content === 'string') {
      out.push({ role: 'assistant', content: msg.content });
      continue;
    }
    const toolUses = msg.content.filter((b): b is ContentBlockToolUse => b.type === 'tool_use');
    const text = textOf(msg);
    out.push({
      role: 'assistant',
      // OpenAI-compatible APIs (DeepSeek, xAI, ...) reject an assistant message with neither content
      // nor tool_calls. A history message with empty text (e.g. a truncated turn) must therefore not
      // serialize to `content: null` with no tools.
      content: text || (toolUses.length > 0 ? null : ' '),
      ...(toolUses.length > 0
        ? {
            tool_calls: toolUses.map((tu) => ({
              id: tu.id,
              type: 'function' as const,
              function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
            })),
          }
        : {}),
    });
  }
  return out;
}

function textOf(msg: ChatMessage): string {
  return typeof msg.content === 'string'
    ? msg.content
    : msg.content
        .filter((b): b is ContentBlockText => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

export class OpenAiCompatProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly modelMeta: import('../config/types.js').ModelMeta;
  private client: OpenAI;
  private label: string;
  /** JSON tool calling protocol mode (deepseek-reasoner, etc.) */
  private jsonMode: boolean;

  constructor(config: DeepcodeConfig, model: string, opts: OpenAiCompatOptions) {
    this.id = opts.id;
    this.model = model;
    this.label = opts.label;
    this.jsonMode = isJsonToolModel(config, model);
    const ep = (config.providers as Record<string, { apiKey?: string; baseUrl?: string } | undefined>)[opts.id] ?? {};
    const apiKey = ep?.apiKey ?? process.env[opts.envKey];
    const baseUrl = ep?.baseUrl ?? opts.defaultBaseUrl;
    if (!apiKey) {
      throw new Error(`No ${opts.label} API key configured: set ${opts.envKey} or fill in providers.${opts.id}.apiKey in ~/.deepcode/config.json`);
    }
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
    // Resolve model metadata from the builtin table + user overrides (config.modelMeta.<model>).
    // maxOutputTokens matters here: without it the agent loop falls back to its own cap, and the
    // request would carry an unbounded max_tokens that the API rejects (HTTP 400).
    const meta = config.modelMeta[model] ?? {};
    const builtin = BUILTIN_MODEL_META[model];
    const maxOutputTokens = meta.maxOutputTokens ?? builtin?.maxOutputTokens;
    this.modelMeta = {
      id: model,
      windowTokens: meta.windowTokens ?? builtin?.windowTokens ?? 128_000,
      supportsVision: meta.supportsVision ?? builtin?.supportsVision ?? false,
      supportsTools: meta.supportsTools ?? builtin?.supportsTools ?? true,
      supportsThinking: meta.supportsThinking ?? builtin?.supportsThinking ?? model.toLowerCase().includes('reasoner'),
      cacheControl: meta.cacheControl ?? builtin?.cacheControl ?? 'auto',
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      toolCallProtocol: this.jsonMode ? 'json' : undefined,
    };
  }

  /**
   * Build the OpenAI chat messages array. When the model supports explicit cache breakpoints
   * (`cacheControl: 'explicit'`), the stable system prompt is pinned with a `cache_control` block so
   * the provider caches that prefix across turns. The system prompt is the largest stable prefix and
   * stays byte-identical turn-to-turn unless the permission mode injects/removes the plan-mode
   * segment (in which case the prefix simply re-caches once — expected, only costs one extra miss).
   */
  private buildMessages(req: LLMRequest, jsonMode: boolean): ChatCompletionMessageParam[] {
    const sysText = jsonMode ? buildJsonToolSystem(req.system, req.tools) : req.system;
    const body = jsonMode ? toJsonModeMessages(req) : toOpenAiMessages(req);
    if (this.modelMeta.cacheControl === 'explicit') {
      const systemMsg = {
        role: 'system',
        content: [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } } as CacheControlTextPart],
      } as ChatCompletionMessageParam;
      return [systemMsg, ...body];
    }
    return [{ role: 'system', content: sysText }, ...body];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const jsonMode = this.jsonMode && req.tools.length > 0;
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.buildMessages(req, jsonMode),
        tools: jsonMode || req.tools.length === 0 ? undefined : toOpenAiTools(req.tools),
        // Never send a max_tokens larger than the context window: APIs validate the value and
        // reject anything above the model's output limit (DeepSeek: > 393216 → HTTP 400).
        max_tokens: Math.min(req.maxTokens, this.modelMeta.windowTokens),
        temperature: req.temperature,
        stream: false,
      },
      { signal: req.signal },
    );
    const choice = res.choices[0];
    const content: ChatMessage['content'] = [];
    const rawText = choice?.message.content ?? '';
    if (jsonMode) {
      // JSON tool calling protocol: parse tool calls
      const parsed = parseJsonToolCalls(rawText);
      if (parsed) {
        if (parsed.response) content.push({ type: 'text', text: parsed.response });
        parsed.toolCalls.forEach((tc, i) => {
          content.push({ type: 'tool_use', id: `json-${i + 1}`, name: tc.name, input: tc.arguments });
        });
      } else {
        content.push({ type: 'text', text: rawText });
      }
    } else {
      if (rawText) content.push({ type: 'text', text: rawText });
      for (const tc of choice?.message.tool_calls ?? []) {
        const fn = (tc as { function?: { name: string; arguments: string } }).function;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(fn?.arguments ?? '{}');
        } catch {
          input = { _raw: fn?.arguments };
        }
        content.push({ type: 'tool_use', id: tc.id, name: fn?.name ?? 'unknown', input });
      }
    }
    return {
      message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
      usage: mapUsage(res.usage),
      stopReason: mapFinishReason(choice?.finish_reason),
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const jsonMode = this.jsonMode && req.tools.length > 0;
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.buildMessages(req, jsonMode),
        tools: jsonMode || req.tools.length === 0 ? undefined : toOpenAiTools(req.tools),
        // Clamp to the context window; see complete() for why (API rejects oversized max_tokens).
        max_tokens: Math.min(req.maxTokens, this.modelMeta.windowTokens),
        temperature: req.temperature,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: req.signal },
    );
    let text = '';
    const toolCalls = new Map<number, ToolCallAcc>();
    let finishReason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'] | null = null;
    let lastUsage: OpenAI.Completions.CompletionUsage | null | undefined = null;

    for await (const chunk of stream) {
      if (chunk.usage) {
        lastUsage = chunk.usage;
        yield { type: 'usage', usage: mapUsage(chunk.usage) };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: 'text-delta', text: delta.content };
      }
      // Forward thinking tokens: DeepSeek uses `reasoning_content`; OpenRouter / Gemini-compatible
      // gateways expose the same field on the OpenAI wire format as `reasoning`.
      const deltaExt = delta as { reasoning_content?: string; reasoning?: string };
      const reasoning = deltaExt.reasoning_content ?? deltaExt.reasoning;
      if (reasoning) yield { type: 'thinking-delta', text: reasoning };
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const first = !toolCalls.has(idx);
        const acc = toolCalls.get(idx) ?? { id: tc.id ?? '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) {
          acc.args += tc.function.arguments;
          yield { type: 'tool-input-delta', id: acc.id, partialJson: tc.function.arguments };
        }
        toolCalls.set(idx, acc);
        if (first && acc.id) {
          yield { type: 'tool-start', id: acc.id, name: acc.name || '(parsing)' };
        } else if (first && !acc.id) {
          // The id has not arrived yet: emit a placeholder event to keep the UI ordering correct
          yield { type: 'tool-start', id: `pending-${idx}`, name: '(parsing)' };
        }
      }
    }

    if (jsonMode) {
      // JSON tool calling protocol: parse the full text to extract tool calls
      const parsed = parseJsonToolCalls(text);
      const blocks: ChatMessage['content'] = [];
      if (parsed) {
        if (parsed.response) blocks.push({ type: 'text', text: parsed.response });
        for (const [i, tc] of parsed.toolCalls.entries()) {
          const id = `json-${i + 1}`;
          blocks.push({ type: 'tool_use', id, name: tc.name, input: tc.arguments });
          yield { type: 'tool-start', id, name: tc.name };
          yield { type: 'tool-input-delta', id, partialJson: JSON.stringify(tc.arguments) };
        }
      } else {
        blocks.push({ type: 'text', text });
      }
      yield {
        type: 'done',
        response: {
          message: { role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] },
          usage: mapUsage(lastUsage),
          stopReason: parsed && parsed.toolCalls.length > 0 ? 'tool_use' : mapFinishReason(finishReason),
        },
      };
      return;
    }

    // Native protocol: tool-start events (order guaranteed)
    const blocks: ChatMessage['content'] = [];
    for (const [, acc] of toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(acc.args || '{}');
      } catch {
        input = { _raw: acc.args };
      }
      blocks.push({ type: 'tool_use', id: acc.id, name: acc.name, input });
      yield { type: 'tool-start', id: acc.id, name: acc.name };
    }
    if (text) blocks.unshift({ type: 'text', text });
    yield {
      type: 'done',
      response: {
        message: { role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] },
        usage: mapUsage(lastUsage),
        stopReason: mapFinishReason(finishReason),
      },
    };
  }
}

function mapUsage(usage: OpenAI.Completions.CompletionUsage | undefined | null) {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  const details = usage as OpenAI.Completions.CompletionUsage & {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    promptCacheHitTokens: details.prompt_cache_hit_tokens ?? details.prompt_tokens_details?.cached_tokens ?? 0,
    promptCacheMissTokens: details.prompt_cache_miss_tokens,
  };
}

function mapFinishReason(
  reason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'] | undefined | null,
): LLMResponse['stopReason'] {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    case null:
    case undefined:
      return 'end_turn';
    default:
      return 'end_turn';
  }
}
