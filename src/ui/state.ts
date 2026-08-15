import type { EngineEvent } from '../events.js';
import type { ApprovalItem } from '../tools/permission.js';
import type { UsageTotals } from '../usage/extractor.js';
import type { ToolResult } from '../tools/types.js';

/** TUI state: pure-function reducer over the event stream (unit-testable) */

export interface ToolCallView {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** Streaming argument deltas */
  inputJson: string;
  status: 'streaming' | 'running' | 'done' | 'error' | 'denied';
  result?: ToolResult;
  durationMs?: number;
}

export interface MessageView {
  id: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking: string;
  toolCalls: ToolCallView[];
  streaming: boolean;
  source: 'user' | 'assistant' | 'memory';
}

export interface ApprovalView {
  requestId: string;
  items: ApprovalItem[];
  /** Index of the currently focused item */
  focusIndex: number;
  /** Feedback edit mode */
  feedbackMode: boolean;
  feedbackText: string;
  resolved: boolean;
}

export interface NoticeView {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'compact' | 'memory' | 'subagent';
  /** Section tag: pushing a notice with a group replaces older notices of the same group,
   *  so command output (e.g. the /models list) cannot be pushed off-screen by later output. */
  group?: string;
}

export interface TUIState {
  messages: MessageView[];
  approvals: ApprovalView[];
  notices: NoticeView[];
  usage: UsageTotals;
  /** Context usage ratio (0-1) */
  contextRatio: number;
  contextWindow: number;
  /** Whether a request is running */
  busy: boolean;
  model: string;
  provider: string;
  sessionId: string;
  workspace: string;
  lastStopReason?: string;
  turnCount: number;
  lastCompaction?: { savedTokens: number; removedTurns: number };
}

export function emptyState(): TUIState {
  return {
    messages: [],
    approvals: [],
    notices: [],
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      costUsd: 0,
      totalTokens: 0,
    },
    contextRatio: 0,
    contextWindow: 128_000,
    busy: false,
    model: '',
    provider: '',
    sessionId: '',
    workspace: '',
    turnCount: 0,
  };
}

// Shared monotonic id source for BOTH messages and notices, so the merged message list
// can be ordered chronologically (message ids and notice ids are comparable).
let seqId = 0;

/** Next id for a message or notice view (also used by pushNotice outside the reducer). */
export function nextSeqId(): number {
  return ++seqId;
}

export function reduceState(state: TUIState, event: EngineEvent): TUIState {
  switch (event.type) {
    case 'session-start':
      return { ...state, sessionId: event.sessionId, provider: event.provider, model: event.model, workspace: event.workspace };

    case 'turn-start':
      return { ...state, busy: true, turnCount: event.turn };

    case 'text-delta': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + event.text };
      } else {
        messages.push({ id: ++seqId, role: 'assistant', text: event.text, thinking: '', toolCalls: [], streaming: true, source: 'assistant' });
      }
      return { ...state, messages };
    }

    case 'thinking-delta': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = { ...last, thinking: last.thinking + event.text };
      } else {
        // Some providers emit thinking before any text — make sure there is a streaming
        // assistant message to attach it to, otherwise the thinking would be silently dropped.
        messages.push({ id: ++seqId, role: 'assistant', text: '', thinking: event.text, toolCalls: [], streaming: true, source: 'assistant' });
      }
      return { ...state, messages };
    }

    case 'message': {
      const messages = [...state.messages];
      if (event.source === 'user') {
        messages.push({ id: ++seqId, role: 'user', text: typeof event.message.content === 'string' ? event.message.content : '', thinking: '', toolCalls: [], streaming: false, source: 'user' });
      } else if (event.source === 'assistant') {
        const last = messages[messages.length - 1];
        const text = typeof event.message.content === 'string' ? event.message.content : event.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        if (last && last.role === 'assistant' && last.streaming) {
          messages[messages.length - 1] = { ...last, text, streaming: false };
        } else {
          messages.push({ id: ++seqId, role: 'assistant', text, thinking: '', toolCalls: [], streaming: false, source: 'assistant' });
        }
      }
      return { ...state, messages };
    }

    case 'turn-end':
      return { ...state, busy: false, lastStopReason: event.stopReason };

    case 'tool-start': {
      const messages = [...state.messages];
      let last = messages[messages.length - 1];
      // If the turn started with a tool call (e.g. Anthropic emits tool_use before any text),
      // there may be no streaming assistant message yet — create one so the tool call is attached.
      if (!last || last.role !== 'assistant' || !last.streaming) {
        last = { id: ++seqId, role: 'assistant', text: '', thinking: '', toolCalls: [], streaming: true, source: 'assistant' };
        messages.push(last);
      }
      messages[messages.length - 1] = {
        ...last,
        toolCalls: [...last.toolCalls, { callId: event.callId, name: event.name, input: event.input, inputJson: '', status: 'streaming' as const }],
      };
      return { ...state, messages };
    }

    case 'tool-input-delta': {
      const messages = state.messages.map((m) => ({
        ...m,
        toolCalls: m.toolCalls.map((tc) =>
          tc.callId === event.callId ? { ...tc, inputJson: tc.inputJson + event.partialJson, status: 'streaming' as const } : tc,
        ),
      }));
      return { ...state, messages };
    }

    case 'tool-result': {
      const messages: MessageView[] = state.messages.map((m) => ({
        ...m,
        toolCalls: m.toolCalls.map((tc): ToolCallView =>
          tc.callId === event.callId
            ? { ...tc, status: event.result.isError ? 'error' : 'done', result: event.result, durationMs: event.durationMs }
            : tc,
        ),
      }));
      return { ...state, messages };
    }

    case 'approval-request': {
      return {
        ...state,
        approvals: [
          ...state.approvals.filter((a) => !a.resolved),
          { requestId: event.requestId, items: event.items, focusIndex: 0, feedbackMode: false, feedbackText: '', resolved: false },
        ],
        busy: false,
      };
    }

    case 'approval-result': {
      return { ...state, approvals: state.approvals.map((a) => (a.requestId === event.requestId ? { ...a, resolved: true } : a)) };
    }

    case 'usage': {
      if (event.usage.partial) return state;
      const u = event.usage;
      return {
        ...state,
        usage: {
          requests: state.usage.requests + 1,
          inputTokens: state.usage.inputTokens + u.inputTokens,
          outputTokens: state.usage.outputTokens + u.outputTokens,
          cacheReadTokens: state.usage.cacheReadTokens + (u.cacheReadTokens ?? 0),
          cacheWriteTokens: state.usage.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
          promptCacheHitTokens: state.usage.promptCacheHitTokens + (u.promptCacheHitTokens ?? 0),
          promptCacheMissTokens: state.usage.promptCacheMissTokens + (u.promptCacheMissTokens ?? 0),
          costUsd: Math.round((state.usage.costUsd + u.costUsd) * 1_000_000) / 1_000_000,
          totalTokens: state.usage.totalTokens + u.inputTokens + u.outputTokens,
        },
      };
    }

    case 'compacted':
      return {
        ...state,
        lastCompaction: { savedTokens: event.plan.savedTokens, removedTurns: event.plan.removedTurns },
        notices: [...state.notices, { id: ++seqId, text: `Context compacted: folded ${event.plan.removedTurns} turns, saved ${formatK(event.plan.savedTokens)} tokens`, kind: 'compact' as const }].slice(-8),
      };

    case 'memory-saved':
      return {
        ...state,
        notices: [...state.notices, { id: ++seqId, text: `Saved ${event.entries.length} memories`, kind: 'memory' as const }].slice(-8),
      };

    case 'subagent-status':
      return {
        ...state,
        notices: [...state.notices, { id: ++seqId, text: `[subagent] ${event.label}: ${event.status}`, kind: 'subagent' as const }].slice(-8),
      };

    case 'interrupted':
      return { ...state, busy: false, notices: [...state.notices, { id: ++seqId, text: 'Interrupted', kind: 'info' as const }].slice(-8) };

    case 'error':
      return { ...state, busy: false, notices: [...state.notices, { id: ++seqId, text: `Error: ${event.message}`, kind: 'error' as const }].slice(-8) };

    case 'session-end':
      return { ...state, busy: false };

    default:
      return state;
  }
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function setContextInfo(state: TUIState, ratio: number, window: number): TUIState {
  return { ...state, contextRatio: ratio, contextWindow: window };
}

/** Add a user message view (when input is submitted) */
export function addUserMessage(state: TUIState, text: string): TUIState {
  return { ...state, messages: [...state.messages, { id: ++seqId, role: 'user', text, thinking: '', toolCalls: [], streaming: false, source: 'user' }] };
}
