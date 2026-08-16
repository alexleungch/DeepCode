import type { ChatMessage } from '../providers/types.js';
import { textContentOf } from '../providers/types.js';
import { estimateMessagesTokens, truncateToTokens } from './token-budget.js';

export interface MemoryExtraction {
  type: string;
  content: string;
}

export interface CompactionPlan {
  messages: ChatMessage[];
  summary: string;
  removedTurns: number;
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  keptRecentTurns: number;
  movedToMemory: MemoryExtraction[];
}

interface CompressorOptions {
  /** Target occupancy after compaction (ratio 0-1) */
  targetRatio: number;
  /** Keep the most recent N turns (assistant+user pairs) */
  keepRecentTurns: number;
  /** Token cap for the summary block */
  maxSummaryTokens: number;
  /** Max chars for a single tool_result content (truncated beyond this) */
  maxToolResultChars: number;
  /** Extract facts from compacted turns (integrates with Agent Memory) */
  extractFacts?: (turns: ChatMessage[]) => MemoryExtraction[];
}

const SUMMARY_HEADER = '<summary>';

/**
 * Automatic context compaction: folds the oldest turns into a structured summary,
 * keeps the most recent N turns as-is, and (if extractFacts is provided)
 * distills the compacted turns into memories.
 * Never modifies the system prompt or tool schemas (cache-prefix stability discipline).
 */export function compressMessages(messages: ChatMessage[], opts: CompressorOptions): CompactionPlan {
  const tokensBefore = estimateMessagesTokens(messages);
  const extracted = opts.extractFacts ? opts.extractFacts(messages) : [];
  const targetTokens = Math.floor(tokensBefore * opts.targetRatio);

  // 1) first clip overly long tool_result content
  let working = messages.map((m) => clipToolResults(m, opts.maxToolResultChars));

  // 2) find the collapsible prefix: keep the last keepRecentTurns (user→assistant) turns + the first user message (anchor)
  const keepTurns = opts.keepRecentTurns;
  const turnStarts: number[] = [];
  for (let i = 0; i < working.length; i++) {
    const m = working[i]!;
    if (m.role === 'user' && (typeof m.content === 'string' ? (m.content as string).length > 0 : true)) {
      const hasToolResult = typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result');
      if (!hasToolResult) turnStarts.push(i);
    }
  }

  // 3) fold from the earliest turn until estimated occupancy is back under the target
  let summaryTokens = 0;
  const summaryParts: string[] = [];
  const removed: ChatMessage[] = [];
  let keepFrom = 0;

  for (let t = 0; t < turnStarts.length - keepTurns; t++) {
    const start = turnStarts[t]!;
    const end = t + 1 < turnStarts.length ? turnStarts[t + 1]! : working.length;
    const turn = working.slice(start, end);
    const summary = summarizeTurn(turn);
    const nextTokens = summaryTokens + estimateTokensSafe(summary) + estimateMessagesTokens(working.slice(end));
    if (nextTokens > targetTokens && summaryTokens > 0) break;
    summaryParts.push(summary);
    summaryTokens += estimateTokensSafe(summary);
    removed.push(...turn);
    keepFrom = end;
  }

  // 4) assemble the new message stream: summary block (user) + kept turns
  const kept = working.slice(keepFrom);
  let summaryText = '';
  if (summaryParts.length > 0) {
    const header = '<summary>\n';
    const body = `# Summary of earlier completed work\n${summaryParts.join('\n')}\n</summary>`;
    const clipped = truncateToTokens(body, opts.maxSummaryTokens);
    summaryText = header + clipped.text + (clipped.truncated ? '\n(summary truncated)' : '');
  }
  const newMessages: ChatMessage[] = [];
  if (summaryText) newMessages.push({ role: 'user', content: summaryText });
  newMessages.push(...kept);

  const tokensAfter = estimateMessagesTokens(newMessages);
  return {
    messages: newMessages,
    summary: summaryText,
    removedTurns: summaryParts.length,
    tokensBefore,
    tokensAfter,
    savedTokens: Math.max(0, tokensBefore - tokensAfter),
    keptRecentTurns: keepTurns,
    movedToMemory: extracted,
  };
}

function clipToolResults(m: ChatMessage, maxChars: number): ChatMessage {
  if (typeof m.content === 'string') return m;
  let changed = false;
  const content = m.content.map((b) => {
    if (b.type === 'tool_result' && b.content.length > maxChars) {
      changed = true;
      return { ...b, content: b.content.slice(0, maxChars) + `\n… (tool output too long, truncated from ${b.content.length} chars)` };
    }
    return b;
  });
  return changed ? { ...m, content } : m;
}

function summarizeTurn(turn: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of turn) {
    const text = textContentOf(m).trim();
    if (!text) continue;
    const prefix = m.role === 'assistant' ? 'A' : 'U';
    if (text.length > 600) {
      parts.push(`${prefix}: ${text.slice(0, 600)}…`);
    } else {
      parts.push(`${prefix}: ${text}`);
    }
  }
  return parts.join('\n');
}

function estimateTokensSafe(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.5));
}
