import Anthropic from '@anthropic-ai/sdk';
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
} from './types.js';
import { toAnthropicTools } from './tool-schema.js';

type AnthropicMessage = Anthropic.MessageParam;

/** Cache TTL values allowed by the SDK */
function ttlString(seconds: number): '5m' | '1h' {
  return seconds >= 3600 ? '1h' : '5m';
}

function toAnthropicMessages(req: LLMRequest): AnthropicMessage[] {
  const breakpoints = new Map(req.cacheBreakpoints?.map((b) => [b.index, ttlString(b.ttlSeconds ?? 300)]) ?? []);
  const out: AnthropicMessage[] = [];
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (!msg) continue;
    const ttl = breakpoints.get(i);
    if (msg.role === 'system') {
      // system messages are merged into user messages upstream; here it is sent as a regular message (content is rare)
      out.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : textOf(msg) });
      continue;
    }
    if (typeof msg.content === 'string') {
      // Anthropic rejects empty text blocks; a placeholder keeps the message valid
      const blocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: msg.content || ' ' }];
      if (ttl !== undefined) {
        (blocks[0] as { cache_control?: unknown }).cache_control = { type: 'ephemeral', ttl };
      }
      out.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: blocks });
      continue;
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') {
        const t = (b as ContentBlockText).text;
        if (t) blocks.push({ type: 'text', text: t }); // Anthropic rejects empty text blocks
      } else if (b.type === 'image') {
        const img = b as ContentBlockImage;
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.base64 },
        });
      } else if (b.type === 'tool_use') {
        const tu = b as ContentBlockToolUse;
        blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      } else if (b.type === 'tool_result') {
        const tr = b as ContentBlockToolResult;
        blocks.push({ type: 'tool_result', tool_use_id: tr.toolUseId, content: tr.content, is_error: tr.isError ?? false });
      }
    }
    if (ttl !== undefined && blocks.length > 0) {
      const last = blocks[blocks.length - 1] as { cache_control?: unknown };
      last.cache_control = { type: 'ephemeral', ttl };
    }
    // Anthropic rejects assistant messages with empty content arrays; keep the turn valid
    if (msg.role === 'assistant' && blocks.length === 0) blocks.push({ type: 'text', text: ' ' });
    out.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: blocks });
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

function buildSystem(req: LLMRequest): Anthropic.TextBlockParam[] {
  const sysTtl = req.cacheBreakpoints?.find((b) => b.index === -1)?.ttlSeconds ?? 300;
  const block: Anthropic.TextBlockParam = {
    type: 'text',
    text: req.system,
    ...(sysTtl !== undefined ? { cache_control: { type: 'ephemeral' as const, ttl: ttlString(sysTtl) } } : {}),
  };
  return [block];
}
export class AnthropicProvider implements LLMProvider {
  readonly id: ProviderId = 'anthropic';
  readonly model: string;
  readonly modelMeta: import('../config/types.js').ModelMeta;
  private client: Anthropic;

  constructor(config: DeepcodeConfig, model: string) {
    this.model = model;
    // Honor the per-model output cap (builtin table + user overrides); Anthropic validates
    // max_tokens against the model's limit and rejects oversized values.
    const maxOutputTokens = config.modelMeta[model]?.maxOutputTokens ?? BUILTIN_MODEL_META[model]?.maxOutputTokens;
    this.modelMeta = {
      id: model,
      windowTokens: 200_000,
      supportsVision: true,
      supportsTools: true,
      supportsThinking: true,
      cacheControl: 'explicit',
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    };
    const ep = config.providers.anthropic;
    const apiKey = ep?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('No Anthropic API key configured: set ANTHROPIC_API_KEY or fill in providers.anthropic.apiKey in ~/.deepcode/config.json');
    }
    this.client = new Anthropic({ apiKey, baseURL: ep?.baseUrl });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const params = this.buildParams(req, false);
    const res = (await this.client.messages.create(params, { signal: req.signal })) as Anthropic.Message;
    return {
      message: { role: 'assistant', content: this.blocksFrom(res.content) },
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? undefined,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? undefined,
      },
      stopReason: mapStopReason(res.stop_reason),
    };
  }

  private buildParams(req: LLMRequest, stream: boolean): Anthropic.MessageCreateParams {
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      system: buildSystem(req),
      messages: toAnthropicMessages(req),
      tools: toAnthropicTools(req.tools) as Anthropic.ToolUnion[],
      stream,
      ...(req.thinkingBudgetTokens ? { thinking: { type: 'enabled' as const, budget_tokens: req.thinkingBudgetTokens } } : {}),
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const params = this.buildParams(req, true);
    const stream = (await this.client.messages.create(params, { signal: req.signal })) as AsyncIterable<Anthropic.RawMessageStreamEvent>;
    let text = '';
    let cacheRead = 0;
    let cacheWrite = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    const toolBlocks = new Map<number, ContentBlockToolUse>();

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          inputTokens = event.message.usage.input_tokens;
          cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          if (event.content_block.type === 'tool_use') {
            const id = event.content_block.id;
            toolBlocks.set(event.index, { type: 'tool_use', id, name: event.content_block.name, input: {} });
            yield { type: 'tool-start', id, name: event.content_block.name };
          }
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string };
          if (delta.type === 'text_delta' && delta.text !== undefined) {
            text += delta.text;
            yield { type: 'text-delta', text: delta.text };
          } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.input = mergePartialJson(block.input, delta.partial_json);
              yield { type: 'tool-input-delta', id: block.id, partialJson: delta.partial_json };
            }
          } else if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
            yield { type: 'thinking-delta', text: delta.thinking };
          }
          break;
        }
        case 'message_delta': {
          outputTokens = event.usage.output_tokens;
          cacheRead = event.usage.cache_read_input_tokens ?? 0;
          if (event.delta.stop_reason) stopReason = mapStopReason(event.delta.stop_reason);
          break;
        }
      }
    }
    void text;
    const content: ChatMessage['content'] = [];
    content.push(...toolBlocks.values());
    yield { type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } };
    yield {
      type: 'done',
      response: {
        message: { role: 'assistant', content: [{ type: 'text', text } as ContentBlockText, ...content] },
        usage: { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
        stopReason,
      },
    };
  }

  private blocksFrom(content: Anthropic.ContentBlock[]): ChatMessage['content'] {
    const out: ChatMessage['content'] = [];
    let text = '';
    for (const b of content) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use') {
        out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> });
      }
    }
    if (text) out.unshift({ type: 'text', text });
    return out.length ? out : [{ type: 'text', text: '' }];
  }
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): LLMResponse['stopReason'] {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/** Incrementally merge tool_use input JSON (streaming partial_json) */
function mergePartialJson(current: Record<string, unknown>, partial: string): Record<string, unknown> {
  if (!partial) return current;
  const keys = Object.keys(current);
  if (keys.length === 0) {
    // No content yet: try to parse
    try {
      const parsed = JSON.parse(partial);
      if (parsed && typeof parsed === 'object') return { ...parsed };
    } catch {
      return current;
    }
  } else {
    // Already has content: merge the delta across all keys (brute-force replay: parse the latest complete value)
    try {
      const parsed = JSON.parse(partial) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') return { ...parsed };
    } catch {
      // Keep as-is
    }
  }
  return current;
}
