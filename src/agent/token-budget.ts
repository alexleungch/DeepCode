import { encode, decode } from 'gpt-tokenizer';
import type { ChatMessage } from '../providers/types.js';
import { textContentOf } from '../providers/types.js';

/**
 * Token estimation: gpt-tokenizer (OpenAI-compatible family); Anthropic/Gemini are calibrated via provider usage.
 * Used for compaction triggers and the /context dashboard.
 */
export function estimateTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 3.5);
  }
}

function estimateMessageTokens(msg: ChatMessage): number {
  const text = textContentOf(msg);
  let tokens = estimateTokens(text);
  if (typeof msg.content !== 'string') {
    const images = msg.content.filter((b) => b.type === 'image').length;
    tokens += images * 800;
  }
  return tokens;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Truncate text to the given token cap (conservative: estimated as chars/3.5) */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * 3.5;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.floor(maxChars)), truncated: true };
}
