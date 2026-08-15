import type { DeepcodeConfig, ProviderId } from '../config/types.js';
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
import { toOpenAiTools, ToolNotSupportedError } from './tool-schema.js';

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

function toOllamaMessages(req: LLMRequest): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : textOf(msg) });
      continue;
    }
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const text = textOf(msg);
    const images = msg.content
      .filter((b): b is ContentBlockImage => b.type === 'image')
      .map((b) => b.base64);
    const toolUses = msg.content.filter((b): b is ContentBlockToolUse => b.type === 'tool_use');
    const toolResults = msg.content.filter((b): b is ContentBlockToolResult => b.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        out.push({ role: 'tool', content: tr.content });
      }
      continue;
    }
    const om: OllamaMessage = { role: msg.role === 'assistant' ? 'assistant' : 'user', content: text };
    if (images.length > 0) om.images = images;
    if (toolUses.length > 0) {
      om.tool_calls = toolUses.map((tu) => ({ function: { name: tu.name, arguments: tu.input } }));
    }
    out.push(om);
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

export class OllamaProvider implements LLMProvider {
  readonly id: ProviderId = 'ollama';
  readonly model: string;
  readonly modelMeta: import('../config/types.js').ModelMeta;
  private baseUrl: string;
  private keepAlive: string;

  constructor(config: DeepcodeConfig, model: string) {
    this.model = model;
    this.baseUrl = config.providers.ollama?.baseUrl ?? 'http://localhost:11434';
    this.keepAlive = config.providers.ollama?.keepAlive ?? '30m';
    this.modelMeta = {
      id: model,
      windowTokens: 128_000,
      supportsVision: false,
      supportsTools: true,
      supportsThinking: false,
      cacheControl: 'auto',
    };
  }

  private async request(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Cannot connect to Ollama (${this.baseUrl}): ${msg} (make sure ` + '`ollama serve`' + ` is running)`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 400 && /tool|function/i.test(text)) {
        throw new ToolNotSupportedError('ollama', this.model, text);
      }
      if (res.status === 404) {
        throw new Error(`Ollama model ${this.model} does not exist: ${text} (you can run ` + `ollama pull ${this.model}` + `)`);
      }
      throw new Error(`Ollama request failed (${res.status}): ${text.slice(0, 500)}`);
    }
    return res;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(req),
      stream: false,
      keep_alive: this.keepAlive,
      options: { num_predict: req.maxTokens },
    };
    if (req.tools.length) body.tools = toOpenAiTools(req.tools);
    const res = await this.request(body, req.signal);
    const data = (await res.json()) as {
      message?: { content?: string; tool_calls?: { function: { name: string; arguments: string | Record<string, unknown> } }[] };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content: ChatMessage['content'] = [];
    if (data.message?.content) content.push({ type: 'text', text: data.message.content });
    for (const tc of data.message?.tool_calls ?? []) {
      const args = typeof tc.function.arguments === 'string' ? safeParse(tc.function.arguments) : tc.function.arguments;
      content.push({
        type: 'tool_use',
        id: `${tc.function.name}:${Math.random().toString(36).slice(2, 10)}`,
        name: tc.function.name,
        input: args,
      });
    }
    return {
      message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(req),
      stream: true,
      keep_alive: this.keepAlive,
      options: { num_predict: req.maxTokens },
    };
    if (req.tools.length) body.tools = toOpenAiTools(req.tools);
    const res = await this.request(body, req.signal);
    if (!res.body) throw new Error('Ollama response has no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const toolUses: ContentBlockToolUse[] = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: {
          message?: { content?: string; tool_calls?: { function: { name: string; arguments: string | Record<string, unknown> } }[] };
          prompt_eval_count?: number;
          eval_count?: number;
          done?: boolean;
        };
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        if (chunk.prompt_eval_count) inputTokens = chunk.prompt_eval_count;
        if (chunk.eval_count) outputTokens += chunk.eval_count;
        if (chunk.message?.content) {
          text += chunk.message.content;
          yield { type: 'text-delta', text: chunk.message.content };
        }
        for (const tc of chunk.message?.tool_calls ?? []) {
          const args = typeof tc.function.arguments === 'string' ? safeParse(tc.function.arguments) : tc.function.arguments;
          const tu: ContentBlockToolUse = {
            type: 'tool_use',
            id: `${tc.function.name}:${Math.random().toString(36).slice(2, 10)}`,
            name: tc.function.name,
            input: args,
          };
          toolUses.push(tu);
          yield { type: 'tool-start', id: tu.id, name: tu.name };
          yield { type: 'tool-input-delta', id: tu.id, partialJson: JSON.stringify(args) };
        }
      }
    }

    const content: ChatMessage['content'] = [];
    if (text) content.push({ type: 'text', text });
    content.push(...toolUses);
    yield { type: 'usage', usage: { inputTokens, outputTokens } };
    yield {
      type: 'done',
      response: {
        message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
        usage: { inputTokens, outputTokens },
        stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
      },
    };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}
