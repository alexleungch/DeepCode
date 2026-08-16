import type { ToolResult } from './tools/types.js';
import type { ApprovalDecision, ApprovalItem } from './tools/permission.js';
import type { UsageEvent } from './usage/extractor.js';
import type { CompactionPlan } from './agent/compressor.js';
import type { ChatMessage } from './providers/types.js';
import type { ProviderId } from './config/types.js';

/** Engine event stream: the single data channel consumed by the TUI and --print renderers */
export type EngineEvent =
  | { type: 'session-start'; sessionId: string; provider: ProviderId; model: string; workspace: string; resumed: boolean }
  | { type: 'turn-start'; turn: number }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'turn-end'; turn: number; stopReason: string }
  | { type: 'tool-start'; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-input-delta'; callId: string; partialJson: string }
  | { type: 'tool-progress'; callId: string; text: string }
  | { type: 'tool-result'; callId: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'approval-request'; requestId: string; items: ApprovalItem[] }
  | { type: 'approval-result'; requestId: string; decisions: ApprovalDecision[] }
  | { type: 'usage'; usage: UsageEvent }
  | { type: 'context'; ratio: number; window: number }
  | { type: 'subagent-status'; subagentId: string; label: string; status: 'running' | 'done' | 'failed' | 'merged'; detail?: string }
  | { type: 'memory-saved'; entries: { type: string; content: string }[] }
  | { type: 'compacted'; plan: CompactionPlan }
  | { type: 'message'; message: ChatMessage; source: 'user' | 'assistant' | 'system' | 'memory' }
  | { type: 'interrupted' }
  | { type: 'error'; message: string }
  | { type: 'session-end'; sessionId: string; reason: string };

export type EngineEventSink = (event: EngineEvent) => void;
