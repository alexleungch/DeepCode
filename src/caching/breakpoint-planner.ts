import type { ChatMessage } from '../providers/types.js';
import { toolResultBlocksOf } from '../providers/types.js';

export interface CacheBreakpoint {
  /** -1 = system; otherwise an index into the messages array */
  index: number;
  ttlSeconds?: number;
}

const MAX_BREAKPOINTS = 4;
const DEFAULT_TTL = 300;

/**
 * Planner for Anthropic cache_control breakpoints.
 * Rules (≤4):
 *   1. system prompt (-1)
 *   2. Last tool_result of the previous turn (the largest stable region reused across turns)
 *   3. Last tool_result of the current turn (if different from 2)
 *   4. Longest user message (if significantly above the threshold)
 */
export function planBreakpoints(messages: ChatMessage[], opts?: { max?: number; ttlSeconds?: number }): CacheBreakpoint[] {
  const max = opts?.max ?? MAX_BREAKPOINTS;
  const ttl = opts?.ttlSeconds ?? DEFAULT_TTL;
  if (max <= 0) return [];
  const out: CacheBreakpoint[] = [{ index: -1, ttlSeconds: ttl }];

  // Find the nearest tool_result message from the end
  const lastToolResultIdx = findLastToolResult(messages);
  if (lastToolResultIdx !== -1 && out.length < max) {
    out.push({ index: lastToolResultIdx, ttlSeconds: ttl });
  }

  // Longest user message (excluding tool_result messages and the first one)
  let largestIdx = -1;
  let largestLen = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role !== 'user') continue;
    if (toolResultBlocksOf(m).length > 0) continue;
    const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
    if (len > largestLen) {
      largestLen = len;
      largestIdx = i;
    }
  }
  if (largestIdx !== -1 && largestLen > 4000 && out.length < max && !out.some((b) => b.index === largestIdx)) {
    out.push({ index: largestIdx, ttlSeconds: ttl });
  }

  return out;
}

function findLastToolResult(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (toolResultBlocksOf(m).length > 0) return i;
  }
  return -1;
}
