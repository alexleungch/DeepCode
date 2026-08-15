import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContentBlockToolUse, LLMProvider } from '../providers/types.js';
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
import type { EngineEventSink } from '../events.js';
import type { SessionRecord } from '../session/types.js';
import type { SessionStore } from '../session/store.js';
import type { TodoStore } from '../tools/native/todo.js';

export interface AgentLoopDeps {
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

const MAX_REQUEST_TOKENS = 8192;

/** Per-model output cap (config.modelMeta.<model>.maxOutputTokens), defaulting to MAX_REQUEST_TOKENS */
function maxOutputTokens(modelMeta: ModelMeta): number {
  return modelMeta.maxOutputTokens ?? MAX_REQUEST_TOKENS;
}

export async function runAgentTurn(deps: AgentLoopDeps, userInput: string): Promise<TurnResult> {
  const { config, provider, registry, executor, gate, usage, session, sessionStore, emit, systemPrompt, approvalHandler, signal } = deps;
  const messages: ChatMessage[] = [...session.messages];
  messages.push({ role: 'user', content: userInput });
  emit({ type: 'message', message: { role: 'user', content: userInput }, source: 'user' });
  sessionStore.appendMessage(session.id, messages[messages.length - 1]!);

  const windowTokens = deps.modelMeta.windowTokens || config.context.maxTokens;
  const compactAtTokens = Math.floor(windowTokens * config.context.compactAt);
  let turns = 0;
  let interrupted = false;
  let finalStopReason = 'end_turn';
  const aborted = new AbortController();

  // ESC interrupt linkage
  const onAbort = () => aborted.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (turns = 0; turns < config.agent.maxTurns; ) {
      turns++;
      emit({ type: 'turn-start', turn: turns });

      // —— pre-request compaction check ——
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
          // verify budget after compaction
          if (estimateMessagesTokens(messages) > compactAtTokens) {
            emit({ type: 'error', message: 'Context exceeds budget even after compaction; request aborted (use /clear or /compact)' });
            finalStopReason = 'over-budget';
            break;
          }
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
        emit({ type: 'turn-end', turn: turns + 1, stopReason: finalStopReason });
        break;
      }

      messages.push(response.message);
      sessionStore.appendMessage(session.id, response.message);
      emit({ type: 'message', message: response.message, source: 'assistant' });

      if (toolUses.length === 0) {
        emit({ type: 'turn-end', turn: turns + 1, stopReason: finalStopReason });
        break;
      }

      const observations = await runToolCalls(deps, toolUses);
      if (observations) {
        for (const msg of observations) {
          messages.push(msg);
          sessionStore.appendMessage(session.id, msg);
          emit({ type: 'message', message: msg, source: 'assistant' });
        }
      } else {
        // all denied/aborted
        finalStopReason = 'tools-denied';
        emit({ type: 'turn-end', turn: turns + 1, stopReason: finalStopReason });
        break;
      }
      emit({ type: 'turn-end', turn: turns + 1, stopReason: finalStopReason });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // persist session
    session.messages = messages;
    session.todos = deps.todoStore.snapshot();
  }

  return { messages, turns, interrupted, stopReason: finalStopReason };
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

/** Execute a batch of tool_use: approval → parallel execution → backfill Observations in original order;
 *  returns [observation, visionMessage?]; returns null if all are denied */
async function runToolCalls(
  deps: AgentLoopDeps,
  toolUses: ContentBlockToolUse[],
): Promise<ChatMessage[] | null> {
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
  for (const item of items) {
    const d = gate.check(item);
    if (d) {
      decisions.set(item.callId, d.action);
      if (d.action === 'deny') emit({ type: 'tool-result', callId: item.callId, name: item.toolName, result: { content: 'Operation denied by permission rules', isError: true }, durationMs: 0 });
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
    if (result.aborted) return null;
    for (const d of result.decisions) {
      decisions.set(d.callId, d.action);
      gate.remember(d);
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
  }

  const maxParallel = Math.max(1, config.agent.maxParallelTools);
  for (let i = 0; i < allowed.length; i += maxParallel) {
    const batch = allowed.slice(i, i + maxParallel);
    await Promise.all(
      batch.map(async (tu) => {
        const toolCtx: ToolContext = {
          ...ctxBase,
          askApproval: async (innerItems) => {
            const r = await approvalHandler(innerItems);
            return r.decisions;
          },
          askApprovalBatch: approvalHandler,
        };
        const result = await executor.execute(tu.name, tu.input, toolCtx);
        results.set(tu.id, result);
      }),
    );
  }

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
  return out;
}
