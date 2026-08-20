import type { EngineEvent } from '../events.js';
import type { ApprovalItem } from '../tools/permission.js';
import type { TodoItem } from '../tools/native/todo.js';
import { emptyTotals, addToTotals, type UsageTotals } from '../usage/extractor.js';
import { formatTokens } from '../agent/token-budget.js';
import type { ToolResult } from '../tools/types.js';
import type { PermissionMode } from '../config/types.js';

/** TUI state: pure-function reducer over the event stream (unit-testable) */

/** Most recently started still-live tool card (for tool-progress events with an empty callId). */
function lastLiveCallId(messages: MessageView[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = messages[i]!.toolCalls;
    for (let j = calls.length - 1; j >= 0; j--) {
      const tc = calls[j]!;
      if (tc.status === 'running' || tc.status === 'streaming') return tc.callId;
    }
  }
  return undefined;
}

export interface ToolCallView {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** Streaming argument deltas */
  inputJson: string;
  /** Live output from the running tool (e.g. bash stdout/stderr) */
  progress: string;
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
  /** Live todo list (driven by the todo_write tool via the todo-updated event). */
  todos: TodoItem[];
  /** Context usage ratio (0-1) */
  contextRatio: number;
  contextWindow: number;
  /** Whether a request is running */
  busy: boolean;
  model: string;
  provider: string;
  sessionId: string;
  workspace: string;
  /** Current git branch (from detectRepo at session start); shown in the top Header */
  branch: string | null;
  /** Current permission mode (ask/acceptEdits/plan/bypassPermissions); drives the status bar badge */
  permissionMode: PermissionMode;
  lastStopReason?: string;
  turnCount: number;
  lastCompaction?: { savedTokens: number; removedTurns: number };
  /** Running subagents (id -> label), for the status bar counter */
  subagents: { id: string; label: string; status: 'running' | 'done' | 'failed' | 'merged' }[];
  /** Name of the most recently started (still running) tool, for the status bar */
  currentTool?: string;
}

export function emptyState(): TUIState {
  return {
    messages: [],
    approvals: [],
    notices: [],
    usage: emptyTotals(),
    todos: [],
    contextRatio: 0,
    contextWindow: 128_000,
    busy: false,
    model: '',
    provider: '',
    sessionId: '',
    workspace: '',
    branch: null,
    permissionMode: 'ask',
    turnCount: 0,
    subagents: [],
  };
}

// Shared monotonic id source for BOTH messages and notices, so the merged message list
// can be ordered chronologically (message ids and notice ids are comparable).
let seqId = 0;

/**
 * TUI memory bounds. The engine compacts `session.messages`, but the TUI message list is a
 * separate array that would otherwise retain every turn's text, thinking, streamed tool input,
 * live progress, and tool results (including base64 screenshots) forever. A long session would
 * grow the heap until V8 OOM-aborts the process (uncatchable) — the "auto-exit" symptom.
 * `trimMessages` keeps a bounded scrollback window; the engine's session file still holds the
 * full history on disk.
 */
const MAX_MESSAGES = 400;
const MAX_SUBAGENTS = 100;
/** Cap per-card live output / streamed JSON so one chatty tool cannot balloon a card. */
const MAX_PROGRESS_CHARS = 30_000;
const MAX_INPUT_JSON_CHARS = 200_000;

function trimMessages(messages: MessageView[]): MessageView[] {
  return messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
}

/** Next id for a message or notice view (also used by pushNotice outside the reducer). */
export function nextSeqId(): number {
  return ++seqId;
}

/**
 * Settle a trailing streaming assistant message (streaming=false), used by the terminal events
 * (turn-end / interrupted / error) so a turn that produced only thinking — or was aborted mid-
 * thinking — never leaves the "Thinking…" spinner stuck. Idempotent: already-settled messages
 * are returned unchanged (the same array reference, so React can bail out).
 */
function settleLastStreaming(messages: MessageView[]): MessageView[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  if (last.role !== 'assistant' || !last.streaming) return messages;
  return [...messages.slice(0, -1), { ...last, streaming: false }];
}

export function reduceState(state: TUIState, event: EngineEvent): TUIState {
  switch (event.type) {
    case 'session-start':
      return { ...state, sessionId: event.sessionId, provider: event.provider, model: event.model, workspace: event.workspace, branch: event.branch };

    case 'turn-start':
      return {
        ...state,
        busy: true,
        turnCount: event.turn,
        // A new turn supersedes transient status notices (Interrupted / Error) and mode notices
        // (Shift+Tab mode switches): drop both groups so they scroll away instead of
        // lingering pinned at the bottom of the live region forever. The persistent [PLAN] badge in
        // the status bar is the always-visible mode indicator; the verbose banner is only a
        // one-time announcement that the next message clears.
        notices: state.notices.filter((n) => n.group !== 'status' && n.group !== 'mode'),
      };

    case 'text-delta': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + event.text };
      } else {
        messages.push({ id: ++seqId, role: 'assistant', text: event.text, thinking: '', toolCalls: [], streaming: true, source: 'assistant' });
      }
      return { ...state, messages: trimMessages(messages) };
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
      return { ...state, messages: trimMessages(messages) };
    }

    case 'message': {
      const messages = [...state.messages];
      if (event.source === 'user') {
        messages.push({ id: ++seqId, role: 'user', text: typeof event.message.content === 'string' ? event.message.content : '', thinking: '', toolCalls: [], streaming: false, source: 'user' });
      } else if (event.source === 'assistant') {
        const last = messages[messages.length - 1];
        const blocks = typeof event.message.content === 'string' ? [] : event.message.content;
        const text =
          typeof event.message.content === 'string'
            ? event.message.content
            : blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        // The provider may deliver tool_use blocks only in the final message (no streaming
        // tool-start events, e.g. a one-shot done response). Materialize cards here so the
        // executor's later tool-start (same callId) dedupes in place instead of spawning a
        // blank assistant message — otherwise the card would render on its own line below the
        // text and the original message would never settle. Streamed cards (created from
        // tool-start with input: {}) also get their full input filled in from the final block.
        const toolCalls: ToolCallView[] = blocks
          .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
          .map((b) => ({ callId: b.id, name: b.name, input: b.input, inputJson: '', progress: '', status: 'streaming' as const }));
        if (last && last.role === 'assistant' && last.streaming) {
          const merged = [...last.toolCalls];
          for (const tc of toolCalls) {
            const idx = merged.findIndex((m) => m.callId === tc.callId);
            if (idx >= 0) merged[idx] = { ...merged[idx]!, input: tc.input, name: tc.name };
            else merged.push(tc);
          }
          messages[messages.length - 1] = { ...last, text, toolCalls: merged, streaming: false };
        } else {
          messages.push({ id: ++seqId, role: 'assistant', text, thinking: '', toolCalls, streaming: false, source: 'assistant' });
        }
      }
      return { ...state, messages: trimMessages(messages) };
    }

    case 'turn-end': {
      // Settle a trailing streaming assistant message: a thinking-only / empty-text turn never
      // emits a `message` event (loop.ts drops it via hasVisibleContent), so without this the
      // spinner would keep spinning forever. The thinking text is preserved for MessageList to
      // render as the visible answer when there is no text.
      return { ...state, busy: false, lastStopReason: event.stopReason, messages: settleLastStreaming(state.messages) };
    }

    case 'tool-start': {
      // If a tool call with this callId already exists (e.g. created from the streamed tool_use block
      // during generation, then re-emitted by the executor with the same id), update it in place
      // rather than appending a duplicate card. The model's tool_use id and the executor's callId are
      // now the same value (loop.ts passes tu.id through), so this prevents the double-card / never-
      // settles corruption described in the bug report.
      const existingIdx = state.messages.findIndex((m) => m.toolCalls.some((tc) => tc.callId === event.callId));
      if (existingIdx >= 0) {
        return {
          ...state,
          currentTool: event.name,
          messages: state.messages.map((m, i) =>
            i === existingIdx
              ? { ...m, toolCalls: m.toolCalls.map((tc) => (tc.callId === event.callId ? { ...tc, name: event.name, input: event.input, status: 'streaming' as const } : tc)) }
              : m,
          ),
        };
      }
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
        toolCalls: [...last.toolCalls, { callId: event.callId, name: event.name, input: event.input, inputJson: '', progress: '', status: 'streaming' as const }],
      };
      return { ...state, currentTool: event.name, messages: trimMessages(messages) };
    }

    case 'tool-input-delta': {
      // Locate the ONE affected message (mirroring tool-start) instead of spreading every
      // message object — tool-input-delta fires ~16ms/frame during streaming, and preserving
      // the identity of untouched messages lets memoized MessageItem/ToolCard skip re-renders.
      const msgIdx = state.messages.findIndex((m) => m.toolCalls.some((tc) => tc.callId === event.callId));
      if (msgIdx < 0) return state;
      const messages = [...state.messages];
      const msg = messages[msgIdx]!;
      messages[msgIdx] = {
        ...msg,
        toolCalls: msg.toolCalls.map((tc) =>
          tc.callId === event.callId
            ? { ...tc, inputJson: (tc.inputJson + event.partialJson).slice(-MAX_INPUT_JSON_CHARS), status: 'streaming' as const }
            : tc,
        ),
      };
      return { ...state, messages };
    }

    case 'tool-progress': {
      // Live output from a running tool (bash stdout/stderr). With a callId, append to that
      // card; with an EMPTY callId (tools that cannot provide one) append ONLY to the most
      // recently started live card — the old code matched every running card at once, so a
      // single bash output line was duplicated across all in-flight tool cards.
      const targetId = event.callId || lastLiveCallId(state.messages);
      if (!targetId) return state;
      const msgIdx = state.messages.findIndex((m) => m.toolCalls.some((tc) => tc.callId === targetId));
      if (msgIdx < 0) return state;
      const messages = [...state.messages];
      const msg = messages[msgIdx]!;
      messages[msgIdx] = {
        ...msg,
        toolCalls: msg.toolCalls.map((tc) =>
          tc.callId === targetId
            ? { ...tc, progress: (tc.progress + event.text).slice(-MAX_PROGRESS_CHARS), status: 'running' as const }
            : tc,
        ),
      };
      return { ...state, messages };
    }

    case 'tool-result': {
      // Update ONLY the message that owns the settled call (identity-preserving for all other
      // messages, so memoized cards skip re-render while this one settles).
      const msgIdx = state.messages.findIndex((m) => m.toolCalls.some((tc) => tc.callId === event.callId));
      if (msgIdx < 0) return { ...state, currentTool: undefined };
      const messages = [...state.messages];
      const msg = messages[msgIdx]!;
      // Strip base64 screenshots from the retained result: the TUI renders only diff/content
      // (ToolCard) and detects image references from message TEXT (ImageCard), so result.images
      // is never displayed. Keeping it pins a full screenshot (100KB-2MB of base64) in TUI state
      // for the whole session — a major leak in browser_review-heavy sessions.
      const { images: _unusedImages, ...stripped } = event.result;
      messages[msgIdx] = {
        ...msg,
        toolCalls: msg.toolCalls.map((tc): ToolCallView =>
          tc.callId === event.callId
            ? { ...tc, status: event.result.isError ? 'error' : 'done', result: stripped, durationMs: event.durationMs }
            : tc,
        ),
      };
      return { ...state, currentTool: undefined, messages };
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
      // The turn is still running (tools execute after approval), so keep busy: true. approval-request
      // sets it false to let the dialog take over the input area; restoring it here re-locks the input
      // and keeps the "Running…" indicator through the tool-execution phase until turn-end.
      return { ...state, busy: true, approvals: state.approvals.map((a) => (a.requestId === event.requestId ? { ...a, resolved: true } : a)) };
    }

    case 'context':
      return { ...state, contextRatio: event.ratio, contextWindow: event.window };

    case 'usage': {
      if (event.usage.partial) return state;
      return { ...state, usage: addToTotals({ ...state.usage }, event.usage) };
    }

    case 'compacted':
      return {
        ...state,
        lastCompaction: { savedTokens: event.plan.savedTokens, removedTurns: event.plan.removedTurns },
        notices: [...state.notices, { id: ++seqId, text: `Context compacted: folded ${event.plan.removedTurns} turns, saved ${formatTokens(event.plan.savedTokens)} tokens`, kind: 'compact' as const }].slice(-8),
      };

    case 'memory-saved':
      return {
        ...state,
        notices: [...state.notices, { id: ++seqId, text: `Saved ${event.entries.length} memories`, kind: 'memory' as const }].slice(-8),
      };

    case 'subagent-status': {
      const others = state.subagents.filter((s) => s.id !== event.subagentId);
      // Bound the subagent roster: a long session with many subagents would otherwise grow
      // `state.subagents` without limit. The status bar only needs the most recent few.
      const subagents = [...others, { id: event.subagentId, label: event.label, status: event.status }].slice(-MAX_SUBAGENTS);
      return {
        ...state,
        subagents,
        notices: [...state.notices, { id: ++seqId, text: `[subagent] ${event.label}: ${event.status}`, kind: 'subagent' as const }].slice(-8),
      };
    }

    case 'todo-updated':
      return { ...state, todos: event.todos };

    case 'interrupted':
      // Same-group semantics: a new Interrupted/Error replaces the previous one instead of
      // stacking, and the next turn-start drops it entirely. Also settle any trailing streaming
      // assistant message so an ESC mid-thinking doesn't leave the spinner spinning.
      return {
        ...state,
        busy: false,
        messages: settleLastStreaming(state.messages),
        notices: [...state.notices.filter((n) => n.group !== 'status'), { id: ++seqId, text: 'Interrupted', kind: 'info' as const, group: 'status' as const }].slice(-8),
      };

    case 'error':
      return {
        ...state,
        busy: false,
        messages: settleLastStreaming(state.messages),
        notices: [...state.notices.filter((n) => n.group !== 'status'), { id: ++seqId, text: `Error: ${event.message}`, kind: 'error' as const, group: 'status' as const }].slice(-8),
      };

    case 'delegated': {
      // The parent loop handed off to a subagent at the segment cap. The subagent's report was
      // already pushed via the 'message' event above, so the reducer only needs to mark the turn
      // done, capture the stop reason, and surface a notice naming the subagent.
      return {
        ...state,
        busy: false,
        lastStopReason: 'delegated',
        messages: settleLastStreaming(state.messages),
        notices: [...state.notices.filter((n) => n.group !== 'status'), { id: ++seqId, text: `[delegated] ${event.label} finished (${event.turns} turns). Report appended.`, kind: 'info' as const, group: 'status' as const }].slice(-8),
      };
    }

    case 'session-end':
      return { ...state, busy: false };

    default:
      return state;
  }
}

export function setContextInfo(state: TUIState, ratio: number, window: number): TUIState {
  return { ...state, contextRatio: ratio, contextWindow: window };
}

/** Add a user message view (when input is submitted) */
export function addUserMessage(state: TUIState, text: string): TUIState {
  return { ...state, messages: [...state.messages, { id: ++seqId, role: 'user', text, thinking: '', toolCalls: [], streaming: false, source: 'user' }] };
}
