import { GoogleGenAI } from '@google/genai';
import type { Content, Part } from '@google/genai';
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
import { toGeminiTools } from './tool-schema.js';

function toGeminiContents(req: LLMRequest): Content[] {
  const out: Content[] = [];
  for (const msg of req.messages) {
    if (msg.role === 'system') continue; // system is handled separately
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
      continue;
    }
    const parts: Part[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') {
        parts.push({ text: (b as ContentBlockText).text });
      } else if (b.type === 'image') {
        const img = b as ContentBlockImage;
        parts.push({ inlineData: { mimeType: img.mediaType, data: img.base64 } });
      } else if (b.type === 'tool_use') {
        const tu = b as ContentBlockToolUse;
        parts.push({ functionCall: { name: tu.name, args: tu.input } });
      } else if (b.type === 'tool_result') {
        const tr = b as ContentBlockToolResult;
        parts.push({
          functionResponse: {
            name: tr.toolUseId.split(':')[0] ?? 'unknown',
            response: { content: tr.content, isError: tr.isError ?? false },
          },
        });
      }
    }
    out.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
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

export class GeminiProvider implements LLMProvider {
  readonly id: ProviderId = 'gemini';
  readonly model: string;
  readonly modelMeta: import('../config/types.js').ModelMeta;
  private ai: GoogleGenAI;

  constructor(config: DeepcodeConfig, model: string) {
    this.model = model;
    this.modelMeta = {
      id: model,
      windowTokens: 1_000_000,
      supportsVision: true,
      supportsTools: true,
      supportsThinking: true,
      cacheControl: 'auto',
    };
    const ep = config.providers.gemini;
    const apiKey = ep?.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('No Gemini API key configured: set GOOGLE_API_KEY or fill in providers.gemini.apiKey in ~/.deepcode/config.json');
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      config: {
        systemInstruction: req.system,
        tools: req.tools.length ? toGeminiTools(req.tools) : undefined,
      },
      contents: toGeminiContents(req),
    });
    const cand = res.candidates?.[0];
    const content: ChatMessage['content'] = [];
    for (const part of cand?.content?.parts ?? []) {
      if (part.text) content.push({ type: 'text', text: part.text });
      if (part.functionCall && part.functionCall.name) {
        content.push({
          type: 'tool_use',
          id: `${part.functionCall.name}:${Math.random().toString(36).slice(2, 10)}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }
    const usage = res.usageMetadata;
    return {
      message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        cachedContentTokenCount: usage?.cachedContentTokenCount ?? 0,
      },
      stopReason: mapFinishReason(cand?.finishReason),
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const res = await this.ai.models.generateContentStream({
      model: this.model,
      config: {
        systemInstruction: req.system,
        tools: req.tools.length ? toGeminiTools(req.tools) : undefined,
      },
      contents: toGeminiContents(req),
    });
    let text = '';
    let finishReason: string | undefined;
    let usage: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } = {};
    const toolUses: ContentBlockToolUse[] = [];

    for await (const chunk of res) {
      if (chunk.usageMetadata) {
        usage = chunk.usageMetadata as typeof usage;
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
            cachedContentTokenCount: usage.cachedContentTokenCount ?? 0,
          },
        };
      }
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      if (cand.finishReason) finishReason = cand.finishReason;
      for (const part of cand.content?.parts ?? []) {
        if (part.text) {
          text += part.text;
          yield { type: 'text-delta', text: part.text };
        }
        if (part.thought) {
          yield { type: 'thinking-delta', text: typeof part.thought === 'string' ? part.thought : '' };
        }
        if (part.functionCall && part.functionCall.name) {
          const tu: ContentBlockToolUse = {
            type: 'tool_use',
            id: `${part.functionCall.name}:${Math.random().toString(36).slice(2, 10)}`,
            name: part.functionCall.name,
            input: (part.functionCall.args ?? {}) as Record<string, unknown>,
          };
          toolUses.push(tu);
          yield { type: 'tool-start', id: tu.id, name: tu.name };
        }
      }
    }

    const content: ChatMessage['content'] = [];
    if (text) content.push({ type: 'text', text });
    content.push(...toolUses);
    yield {
      type: 'done',
      response: {
        message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
        usage: {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          cachedContentTokenCount: usage.cachedContentTokenCount ?? 0,
        },
        stopReason: mapFinishReason(finishReason),
      },
    };
  }
}

function mapFinishReason(reason: string | undefined | null): LLMResponse['stopReason'] {
  switch (reason) {
    case 'FUNCTION_CALL':
      return 'tool_use';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'STOP':
    default:
      return 'end_turn';
  }
}
