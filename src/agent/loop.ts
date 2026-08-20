import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContentBlockToolUse, LLMProvider } from '../providers/types.js';
import { textContentOf } from '../providers/types.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ToolContext, ToolDef } from '../tools/types.js';
import { PermissionGate, riskOf, type ApprovalItem, type ApprovalResult } from '../tools/permission.js';
import type { ToolRegistry } from '../tools/registry.js';
import { UsageTracker } from '../usage/extractor.js';
import { pricingFor } from '../config/defaults.js';
import type { DeepcodeConfig, ModelMeta } from '../config/types.js';
import { planBreakpoints } from '../caching/breakpoint-planner.js';
import { compressMessages, type CompactionPlan, type MemoryExtraction } from './compressor.js';
import { estimateMessagesTokens } from './token-budget.js';
import { expandAtRefs } from './at-refs.js';
import type { EngineEventSink } from '../events.js';
import type { SessionRecord } from '../session/types.js';
import type { SessionStore } from '../session/store.js';
import type { TodoStore } from '../tools/native/todo.js';

interface AgentLoopDeps {
  config: DeepcodeConfig;
  provider: LLMProvider;
  modelMeta: ModelMeta;
  registry: ToolRegistry;
  executor: ToolExecutor;
  gate: PermissionGate;
  usage: UsageTracker;
  session: SessionRecord;
  sessionStore: SessionStore;
  todoStore: TodoStore;
  emit: EngineEventSink;
  systemPrompt: string;
  /** Workspace cwd used to resolve `@file` references in user input */
  workspace?: string;
  /** Approval handler (TUI dialog / --print stdin / test injection) */
  approvalHandler: (items: ApprovalItem[]) => Promise<ApprovalResult>;
  /** Extract facts from compacted turns (Agent Memory integration; skipped if absent) */
  extractFacts?: (turns: ChatMessage[]) => MemoryExtraction[];
  signal: AbortSignal;
  /** Sub-agent runtime (task tool) */
  subagentRuntime?: import('../tools/types.js').SubagentRuntime;
  /** Current sub-agent depth */
  subagentDepth?: number;
}

export interface TurnResult {
  messages: ChatMessage[];
  turns: number;
  interrupted: boolean;
  stopReason: string;
}

/**
 * Fallback output cap when a model has no explicit maxOutputTokens. Must stay within the accepted
 * range of every target API: OpenAI-compatible endpoints validate max_tokens against the model's
 * output limit and reject oversized values with HTTP 400 (e.g. DeepSeek rejects anything > 393216).
 * The previous default of 100M caused exactly that error on deepseek-v4-flash.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/** Per-model output cap (config.modelMeta.<model>.maxOutputTokens); defaults to the model's context
 *  window, clamped to DEFAULT_MAX_OUTPUT_TOKENS so the sent value is always within every API's range. */
export function maxOutputTokens(modelMeta: ModelMeta): number {
  return modelMeta.maxOutputTokens ?? Math.min(modelMeta.windowTokens || DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
}

export async function runAgentTurn(deps: AgentLoopDeps, userInput: string): Promise<TurnResult> {
  const { config, provider, registry, executor, gate, usage, session, sessionStore, emit, systemPrompt, approvalHandler, signal } = deps;
  const messages: ChatMessage[] = [...session.messages];
  // Expand `@file` references: the MODEL receives the original text plus `<context>`
  // blocks with the referenced file contents; the DISPLAY event keeps the text exactly
  // as the user typed it (the TUI shows `@src/a.ts`, not a wall of file contents).
  // The session stores the expanded message, so resumption/compaction keep the content.
  const atExpansion = expandAtRefs(userInput, deps.workspace ?? process.cwd());
  messages.push({ role: 'user', content: atExpansion.expanded });
  emit({ type: 'message', message: { role: 'user', content: userInput }, source: 'user' });
  sessionStore.appendMessage(session.id, messages[messages.length - 1]!);

  const windowTokens = deps.modelMeta.windowTokens || config.context.maxTokens;
  // Live context-usage broadcast: recomputed from the in-scope `messages` array (accurate mid-turn,
  // unlike engine.contextRatio() which only sees session.messages after the turn finishes). Consumed
  // by the TUI reducer to keep the status-bar ctx bar and /context panel in sync as the conversation grows.
  const emitContext = () => emit({ type: 'context', ratio: estimateMessagesTokens(messages) / windowTokens, window: windowTokens });
  const compactAtTokens = Math.floor(windowTokens * config.context.compactAt);
  const maxTurns = config.agent.maxTurns;
  const maxTotalTurns = config.agent.maxTotalTurns ?? Math.max(maxTurns, 100);
  const compactEveryTurns = config.context.compactEveryTurns ?? 0;
  // Two counters: `segmentTurns` counts turns since the last compaction (compaction resets it, so a
  // long task survives past `maxTurns` as long as each segment makes progress); `totalTurns` is the
  // hard safety backstop that can never be reset — a runaway tool loop must eventually stop.
  let totalTurns = 0;
  let segmentTurns = 0;
  let interrupted = false;
  let finalStopReason = 'end_turn';
  const aborted = new AbortController();

  // ESC interrupt linkage
  const onAbort = () => aborted.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (totalTurns = 0; totalTurns < maxTotalTurns; ) {
      // Segment cap check FIRST (top of the loop, before the increment): this reproduces the
      // original `for (turns = 0; turns < maxTurns;)` semantics — exactly `maxTurns` model calls
      // per segment. A successful compaction resets `segmentTurns` to 0, so a productive task
      // passes straight through here and keeps going.
      //
      // Before giving up we make one last-ditch attempt with very aggressive parameters: a
      // lower target ratio, fewer kept recent turns, and tighter tool-result clipping. If even
      // THIS cannot reduce the conversation, the task really is stuck — emit the diagnostic
      // error and stop. The `maxTotalTurns` backstop in the for-condition catches any runaway
      // compaction loop.
      if (segmentTurns >= maxTurns) {
        if (config.context.autoCompact) {
          // Strategy 1: aggressive per-turn summarize compaction (handles multi-prompt conversations).
          const lastResort = compressMessages(messages, {
            targetRatio: 0.3,
            keepRecentTurns: Math.max(2, config.context.keepRecentTurns - 3),
            maxSummaryTokens: config.context.maxSummaryTokens,
            maxToolResultChars: 2000,
            extractFacts: deps.extractFacts,
          });
          if (lastResort.removedTurns > 0) {
            messages.splice(0, messages.length, ...lastResort.messages);
            sessionStore.appendCompaction(session.id, lastResort);
            emit({ type: 'compacted', plan: lastResort });
            emitContext();
            segmentTurns = 0;
            continue;
          }
          // Strategy 2: middle-fold (handles single-prompt long tool-using tasks where the
          // per-turn compressor finds no foldable user→assistant turns). Keep the first
          // message (anchor) + the most recent 4 messages as live context, summarize the rest.
          const mid = middleFoldMessages(messages, { keepRecentMessages: 4 });
          if (mid.removedTurns > 0) {
            messages.splice(0, messages.length, ...mid.messages);
            const foldPlan = {
              messages: mid.messages,
              summary: '<summary>middle-fold at segment boundary</summary>',
              removedTurns: mid.removedTurns,
              tokensBefore: mid.tokensBefore,
              tokensAfter: mid.tokensAfter,
              savedTokens: mid.tokensBefore - mid.tokensAfter,
              keptRecentTurns: 0,
              movedToMemory: [],
            };
            sessionStore.appendCompaction(session.id, foldPlan);
            emit({ type: 'compacted', plan: foldPlan });
            emitContext();
            segmentTurns = 0;
            continue;
          }
        }
        // Both compaction strategies (when attempted) failed. Try delegating the remaining work
        // to a subagent with its own turn budget — strategy 3 from src/agent/subagent.ts:65-68.
        // The subagent runs in a fresh context, so a single-prompt tool-loop task that refuses to
        // fold can finish there instead of silently abandoning the user mid-work. Falls back to a
        // reset+continue (with the existing warning) if delegation is unavailable or itself fails;
        // the maxTotalTurns backstop below is the genuine runaway guard.
        const canDelegate =
          !!deps.subagentRuntime &&
          config.subagents.enabled !== false &&
          (deps.subagentDepth ?? 0) < config.subagents.maxDepth;
        if (canDelegate) {
          const delegationTask = buildDelegationTask(messages, maxTurns);
          try {
            const subResult = await deps.subagentRuntime!.spawn({
              task: delegationTask,
              label: 'segment-cap delegation',
              depth: (deps.subagentDepth ?? 0) + 1,
              workspace: session.workspace,
            });
            if (!subResult.error && subResult.report) {
              const delegatedMessage: ChatMessage = { role: 'assistant', content: subResult.report };
              messages.push(delegatedMessage);
              sessionStore.appendMessage(session.id, delegatedMessage);
              emit({ type: 'message', message: delegatedMessage, source: 'assistant' });
              emit({ type: 'delegated', subagentId: subResult.subagentId, label: subResult.label, report: subResult.report, turns: subResult.turns });
              finalStopReason = 'delegated';
              emit({ type: 'turn-end', turn: totalTurns + 1, stopReason: finalStopReason });
              emitContext();
              break;
            }
          } catch {
            // Delegation threw — fall through to the reset+continue fallback below.
          }
        }
        // Fallback: warn (informational), reset the per-segment counter, and continue. The
        // task is genuinely stuck only if even the hard maxTotalTurns backstop fires below.
        emit({
          type: 'error',
          message: config.context.autoCompact
            ? `Reached the configured agent.maxTurns limit (${maxTurns}) within a segment (compaction did not reduce the conversation). Continuing; the hard maxTotalTurns backstop (${maxTotalTurns}) will stop a truly stuck task.`
            : `Reached the configured agent.maxTurns limit (${maxTurns}) within a segment (auto-compaction is disabled). Continuing; the hard maxTotalTurns backstop (${maxTotalTurns}) will stop a truly stuck task.`,
        });
        segmentTurns = 0;
        continue;
      }
      totalTurns++;
      segmentTurns++;
      emit({ type: 'turn-start', turn: totalTurns });

      // —— pre-request compaction check (token-based) ——
      if (config.context.autoCompact && estimateMessagesTokens(messages) > compactAtTokens) {
        const plan = compressMessages(messages, {
          targetRatio: 0.6,
          keepRecentTurns: config.context.keepRecentTurns,
          maxSummaryTokens: config.context.maxSummaryTokens,
          maxToolResultChars: 8000,
          extractFacts: deps.extractFacts,
        });
        if (plan.removedTurns > 0) {
          messages.splice(0, messages.length, ...plan.messages);
          sessionStore.appendCompaction(session.id, plan);
          emit({ type: 'compacted', plan });
          emitContext();
          // verify budget after compaction
          if (estimateMessagesTokens(messages) > compactAtTokens) {
            emit({ type: 'error', message: 'Context exceeds budget even after compaction; request aborted (use /clear or /compact)' });
            finalStopReason = 'over-budget';
            break;
          }
        }
      }

      // —— pre-request turn-based compaction (strategy 1: state checkpoint & counter reset) ——
      // Every `compactEveryTurns` turns, force a compaction. If it actually removed turns, reset the
      // per-segment counter so the task can continue. If there is nothing to compress (e.g. the whole
      // conversation is a single giant turn), we cannot reset — fall through and let the maxTurns
      // segment cap trip instead of looping forever.
      if (compactEveryTurns > 0 && segmentTurns >= compactEveryTurns) {
        const plan = compressMessages(messages, {
          targetRatio: 0.6,
          keepRecentTurns: config.context.keepRecentTurns,
          maxSummaryTokens: config.context.maxSummaryTokens,
          maxToolResultChars: 8000,
          extractFacts: deps.extractFacts,
        });
        if (plan.removedTurns > 0) {
          messages.splice(0, messages.length, ...plan.messages);
          sessionStore.appendCompaction(session.id, plan);
          emit({ type: 'compacted', plan });
          emitContext();
          segmentTurns = 0; // counter reset — the task keeps going with a fresh budget
        }
      }

      // —— assemble request ——
      const breakpoints = provider.modelMeta.cacheControl === 'explicit' ? planBreakpoints(messages) : undefined;
      const request = {
        system: systemPrompt,
        messages,
        tools: registry.schemas(),
        maxTokens: maxOutputTokens(deps.modelMeta),
        cacheBreakpoints: breakpoints,
        thinkingBudgetTokens: provider.modelMeta.supportsThinking ? 4096 : undefined,
        signal: aborted.signal,
      };

      // —— streaming request ——
      let response;
      try {
        response = await consumeStream(provider, request, emit, usage, session.id);
      } catch (e) {
        if (aborted.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
          interrupted = true;
          emit({ type: 'interrupted' });
          break;
        }
        emit({ type: 'error', message: `Model request failed: ${e instanceof Error ? e.message : String(e)}` });
        finalStopReason = 'error';
        break;
      }
      if (!response) break;

      finalStopReason = response.stopReason;

      // —— tool calls ——
      const toolUses: ContentBlockToolUse[] = (typeof response.message.content === 'string' ? [] : response.message.content).filter(
        (b): b is ContentBlockToolUse => b.type === 'tool_use',
      );

      // Drop a completely empty assistant turn (e.g. the response was truncated before producing any
      // content or tool call). Persisting it would poison the next request: OpenAI-compatible APIs
      // reject an assistant message with neither content nor tool_calls ("Invalid assistant message").
      if (toolUses.length === 0 && !hasVisibleContent(response.message)) {
        emit({ type: 'turn-end', turn: totalTurns + 1, stopReason: finalStopReason });
        emitContext();
        break;
      }

      messages.push(response.message);
      sessionStore.appendMessage(session.id, response.message);
      emit({ type: 'message', message: response.message, source: 'assistant' });

      if (toolUses.length === 0) {
        emit({ type: 'turn-end', turn: totalTurns + 1, stopReason: finalStopReason });
        emitContext();
        break;
      }

      const outcome = await runToolCalls(deps, toolUses);
      if (outcome.observations) {
        for (const msg of outcome.observations) {
          messages.push(msg);
          sessionStore.appendMessage(session.id, msg);
          // Observations (tool_result blocks, optional vision images) are internal conversation
          // turns for the model's next step — they are NOT displayed as separate chat lines. The
          // tool card (tool-start/tool-result events) already surfaces the result; emitting them
          // here with source:'assistant' + empty text would push a blank assistant message per batch.
        }
      }
      // An aborted batch (or one where every tool was denied) ends the turn: the backfill above
      // keeps the conversation valid for the NEXT request, but the model must not be called again
      // within this turn.
      if (outcome.aborted || !outcome.observations) {
        finalStopReason = 'tools-denied';
        // When the abort came from ESC (interrupt signal), report it as an interrupt so callers
        // (engine.runTurn, the TUI) can distinguish "user interrupted" from "tools denied".
        if (signal.aborted) interrupted = true;
        emit({ type: 'turn-end', turn: totalTurns + 1, stopReason: finalStopReason });
        emitContext();
        break;
      }
      emit({ type: 'turn-end', turn: totalTurns + 1, stopReason: finalStopReason });
      emitContext();
    }

    // —— hard total-turns backstop ——
    // The segment boundary above already emits its own diagnostic when the per-segment cap is hit
    // and compaction cannot reduce the conversation. Here we only handle the global backstop:
    // `maxTotalTurns` is the absolute ceiling that can never be reset, so a runaway compaction
    // loop or a pathologically irreducible task still terminates eventually.
    if (totalTurns >= maxTotalTurns && !interrupted) {
      finalStopReason = 'max-total-turns';
      emit({
        type: 'error',
        message: `Reached the hard total-turn limit (${maxTotalTurns}) for this request. The task may be incomplete — send another message to continue, or raise agent.maxTurns / agent.maxTotalTurns in your config.`,
      });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // persist session
    session.messages = messages;
    session.todos = deps.todoStore.snapshot();
  }

  return { messages, turns: totalTurns, interrupted, stopReason: finalStopReason };
}

async function consumeStream(
  provider: LLMProvider,
  request: Parameters<LLMProvider['stream']>[0],
  emit: EngineEventSink,
  usage: UsageTracker,
  sessionId: string,
) {
  const started = Date.now();
  for await (const event of provider.stream(request)) {
    if (event.type === 'text-delta') emit({ type: 'text-delta', text: event.text });
    else if (event.type === 'thinking-delta') emit({ type: 'thinking-delta', text: event.text });
    else if (event.type === 'tool-start') emit({ type: 'tool-start', callId: event.id, name: event.name, input: {} });
    else if (event.type === 'tool-input-delta') emit({ type: 'tool-input-delta', callId: event.id, partialJson: event.partialJson });
    else if (event.type === 'usage') {
      // mid-stream usage: forwarded to the UI in real time (not booked; the final done event is authoritative)
      const ue = usage.peek(provider.id, provider.model, event.usage, { latencyMs: Date.now() - started, partial: true });
      emit({ type: 'usage', usage: ue });
    } else if (event.type === 'done') {
      const ue = usage.track(sessionId, provider.id, provider.model, event.response.usage, { latencyMs: Date.now() - started });
      emit({ type: 'usage', usage: ue });
      return event.response;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }
  throw new Error('Streaming response ended early (no done event received)');
}

/** Whether an assistant response contains any visible text or tool calls (i.e. is worth persisting) */
function hasVisibleContent(message: ChatMessage): boolean {
  if (typeof message.content === 'string') return message.content.trim().length > 0;
  return message.content.some((b) => (b.type === 'text' && b.text.trim().length > 0) || b.type === 'tool_use');
}

/**
 * Middle-fold: for conversations with a single user prompt followed by many tool rounds (where
 * the standard per-turn compressor finds no foldable user→assistant turns), summarize the
 * MIDDLE of the conversation while keeping the first message (anchor) and the most recent N
 * messages (live context). Used as a last-resort compaction at the segment boundary so a long
 * tool-using task never silently stops at `agent.maxTurns` just because there is nothing
 * foldable in the traditional sense.
 */
function middleFoldMessages(
  messages: ChatMessage[],
  opts: { keepRecentMessages: number },
): { messages: ChatMessage[]; removedTurns: number; tokensBefore: number; tokensAfter: number } {
  const tokensBefore = estimateMessagesTokens(messages);
  // Need at least anchor + 1 middle message + 1 recent for the fold to do anything.
  if (messages.length <= opts.keepRecentMessages + 2) {
    return { messages, removedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }
  const anchorEnd = 1;
  const recentStart = messages.length - opts.keepRecentMessages;
  const middle = messages.slice(anchorEnd, recentStart);
  if (middle.length === 0) {
    return { messages, removedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }
  const summaryParts: string[] = [];
  for (const m of middle) {
    const text = textContentOf(m).trim();
    if (!text) continue;
    const prefix = m.role === 'assistant' ? 'A' : 'U';
    if (text.length > 600) {
      summaryParts.push(`${prefix}: ${text.slice(0, 600)}…`);
    } else {
      summaryParts.push(`${prefix}: ${text}`);
    }
  }
  const summaryBody = `# Summary of earlier tool work\n${summaryParts.join('\n')}`;
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `<summary>\n${summaryBody}\n</summary>`,
  };
  const newMessages: ChatMessage[] = [messages[0]!, summaryMessage, ...messages.slice(recentStart)];
  const tokensAfter = estimateMessagesTokens(newMessages);
  if (tokensAfter >= tokensBefore) {
    return { messages, removedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }
  return { messages: newMessages, removedTurns: middle.length, tokensBefore, tokensAfter };
}

/**
 * Build the task prompt for a subagent that takes over when the parent's segment cap trips and
 * compaction cannot reduce the conversation. The subagent runs in a fresh context, so it needs
 * (a) the user's original request and (b) a compact recap of recent exchanges so it doesn't
 * redo work that's already done. Tool results from the parent's session are not forwarded — the
 * subagent re-reads files / re-runs commands as needed in its own context.
 */
function buildDelegationTask(messages: ChatMessage[], maxTurns: number): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser
    ? (typeof lastUser.content === 'string' ? lastUser.content : textContentOf(lastUser))
    : '(no user message found)';
  const recent = messages.slice(-8);
  const recap = recent
    .map((m) => {
      const text = textContentOf(m).trim();
      if (!text) return null;
      const label = m.role === 'user' ? 'U' : m.role === 'assistant' ? 'A' : m.role === 'system' ? 'S' : '?';
      const trimmed = text.length > 300 ? text.slice(0, 300) + '…' : text;
      return `${label}: ${trimmed}`;
    })
    .filter((s): s is string => Boolean(s))
    .join('\n');
  return `The parent agent hit its per-segment turn cap (${maxTurns}) and compaction could not reduce the conversation, so it is delegating the remaining work to you in a fresh context.

# Original request
${userText}

# Recent exchanges (recap)
${recap}

Continue the task to completion in your fresh context. You may re-read files / re-run commands as needed — prior tool results are NOT in your context. When done, output a concise ## Report describing what you accomplished, what verification you ran (e.g. tests/build), and any remaining issues or follow-up steps for the user.`;
}

/** Result of a tool batch: observation messages to append, plus whether the batch was aborted. */
interface ToolCallOutcome {
  /** User message(s) carrying the tool_result blocks (backfill for denied/aborted tools), or
   *  null when every tool was denied (nothing to append). */
  observations: ChatMessage[] | null;
  /** True when the user aborted the batch — the turn must stop after persisting observations,
   *  without issuing another model call. */
  aborted: boolean;
}

/** Execute a batch of tool_use: approval → parallel execution → backfill Observations in original order;
 *  returns the observation messages (or null if all are denied), plus whether the batch was aborted */
async function runToolCalls(
  deps: AgentLoopDeps,
  toolUses: ContentBlockToolUse[],
): Promise<ToolCallOutcome> {
  const { config, registry, executor, gate, emit, approvalHandler, signal } = deps;

  // 1) build approval items
  const items: ApprovalItem[] = [];
  const ctxBase: Omit<ToolContext, 'askApproval' | 'askApprovalBatch'> = {
    cwd: deps.session.workspace,
    workspace: deps.session.workspace,
    sessionId: deps.session.id,
    config,
    permissionMode: config.permissions.mode,
    emit,
    signal,
    subagents: deps.subagentRuntime,
    subagentDepth: deps.subagentDepth ?? 0,
    addAllowedDir: (dir) => gate.addAllowedDir(dir),
  };

  for (const tu of toolUses) {
    const tool: ToolDef | undefined = registry.get(tu.name);
    const description = tool?.description ?? 'unknown tool';
    let preview: import('../tools/types.js').ToolPreview = { description };
    if (tool?.preview) {
      try {
        preview = await tool.preview(tu.input, {
          ...ctxBase,
          askApproval: async () => [],
          askApprovalBatch: async () => ({ decisions: [], aborted: false }),
        });
      } catch {
        // preview failure does not block
      }
    }
    items.push({
      callId: tu.id,
      toolName: tu.name,
      description: preview.description,
      command: preview.command,
      diff: preview.diff,
      path: preview.path,
      risk: riskOf(tu.name, preview.command ?? preview.description, preview.path),
    });
  }

  // 2) gate decisions (hard deny / auto allow) + pending list
  const decisions = new Map<string, 'allow' | 'deny' | 'allow-always' | 'deny-always'>();
  const pending: ApprovalItem[] = [];
  // CallIds already settled with a tool-result by the hard-deny guardrail, so the step-4
  // settle below does not emit a duplicate card update.
  const hardDenied = new Set<string>();
  for (const item of items) {
    const d = gate.check(item);
    if (d) {
      decisions.set(item.callId, d.action);
      if (d.action === 'deny') {
        hardDenied.add(item.callId);
        emit({ type: 'tool-result', callId: item.callId, name: item.toolName, result: { content: 'Operation denied by permission rules', isError: true }, durationMs: 0 });
      }
    } else {
      pending.push(item);
    }
  }

  // 3) batch approval
  if (pending.length > 0) {
    const requestId = randomUUID().slice(0, 8);
    emit({ type: 'approval-request', requestId, items: pending });
    const result = await approvalHandler(pending);
    emit({ type: 'approval-result', requestId, decisions: result.decisions });
    if (result.aborted) {
      // Nothing runs after an abort: settle the pending cards so their messages can settle
      // too (otherwise the streamed tool_use cards would stay "…" in the live region forever).
      for (const item of pending) {
        emit({ type: 'tool-result', callId: item.callId, name: item.toolName, result: { content: 'Approval aborted', isError: true }, durationMs: 0 });
      }
      // Backfill a tool_result for EVERY tool_use (pending + hard-denied) so the conversation stays
      // valid: an assistant message ending in a bare tool_use is rejected by the APIs on the next
      // request ("every tool_use must have a tool_result"). Previously this returned null and left
      // an orphan tool_use persisted, poisoning the next turn with an HTTP 400.
      const blocks = toolUses.map((tu) => ({
        type: 'tool_result' as const,
        toolUseId: tu.id,
        content: pending.some((p) => p.callId === tu.id) ? 'Approval aborted' : 'Operation denied by permission rules',
        isError: true,
      }));
      return { observations: [{ role: 'user', content: blocks }], aborted: true };
    }
    for (const d of result.decisions) {
      decisions.set(d.callId, d.action);
      // toolName lets gate.remember() record allow-always/deny-always even when the decision
      // was produced outside a check() registration (e.g. tests or handlers that return it directly).
      gate.remember({ ...d, toolName: d.toolName ?? items.find((i) => i.callId === d.callId)?.toolName });
    }
    for (const item of pending) {
      if (!decisions.has(item.callId)) decisions.set(item.callId, 'deny');
    }
  }

  // 4) parallel execution (concurrency cap; keep original order)
  const allowed = toolUses.filter((tu) => decisions.get(tu.id) === 'allow' || decisions.get(tu.id) === 'allow-always');
  const denied = toolUses.filter((tu) => decisions.get(tu.id) === 'deny' || decisions.get(tu.id) === 'deny-always');
  const results = new Map<string, { content: string; isError?: boolean; diff?: string; artifacts?: { path: string }[]; images?: { mediaType: string; base64: string }[] }>();

  for (const tu of denied) {
    results.set(tu.id, { content: 'User denied this operation', isError: true });
    // User-denied tools never execute, so the executor never emits tool-result for them. Without
    // this settle the streamed card stays "…" forever and the assistant message never reaches a
    // terminal state (it would remain in the live region and break render ordering). Hard-denied
    // tools were already settled in step 2 and are skipped here to avoid a duplicate emit.
    if (!hardDenied.has(tu.id)) {
      emit({ type: 'tool-result', callId: tu.id, name: tu.name, result: { content: 'User denied this operation', isError: true }, durationMs: 0 });
    }
  }

  const maxParallel = Math.max(1, config.agent.maxParallelTools);
  const settle = (callId: string, name: string, content: string) => {
    emit({ type: 'tool-result', callId, name, result: { content, isError: true }, durationMs: 0 });
  };
  for (let i = 0; i < allowed.length; i += maxParallel) {
    const batch = allowed.slice(i, i + maxParallel);
    await Promise.all(
      batch.map(async (tu) => {
        // A tool starts only if the turn was not already aborted (ESC during execution/approval).
        // The abort-aware executor then races every tool against the turn signal, so a tool that
        // is still running when Ctrl+C arrives is killed and settles with an interrupted result.
        if (signal.aborted) {
          settle(tu.id, tu.name, 'Turn interrupted — tool did not start');
          return;
        }
        const toolCtx: ToolContext = {
          ...ctxBase,
          callId: tu.id,
          askApproval: async (innerItems) => {
            const r = await approvalHandler(innerItems);
            return r.decisions;
          },
          askApprovalBatch: approvalHandler,
        };
        const result = await executor.execute(tu.name, tu.input, toolCtx, tu.id);
        results.set(tu.id, result);
      }),
    );
  }
  // A batch that was interrupted mid-execution is treated as aborted: the running tools were
  // killed by the executor (or short-circuited above), so the turn must end instead of calling
  // the model again with a half-run batch.
  if (signal.aborted) return { observations: [], aborted: true };

  // 5) backfill tool_result in original order; append an image message when screenshots exist and the model supports vision
  const blocks: ChatMessage['content'] = toolUses.map((tu) => {
    const r = results.get(tu.id);
    return {
      type: 'tool_result',
      toolUseId: tu.id,
      content: r?.content ?? '(no result)',
      isError: r?.isError ?? false,
    };
  });
  const out: ChatMessage[] = [{ role: 'user', content: blocks }];

  // vision injection: collect images from all tool results
  if (deps.modelMeta.supportsVision) {
    const images = toolUses.flatMap((tu) => {
      const r = results.get(tu.id);
      return r?.images ?? [];
    });
    if (images.length > 0) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: 'The following are browser rendering screenshots (captured by browser_review); use them to verify the UI rendering:' },
          ...images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, base64: img.base64 })),
        ],
      });
    }
  }
  return { observations: out, aborted: false };
}
