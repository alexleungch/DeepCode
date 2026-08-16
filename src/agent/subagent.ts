import { randomUUID } from 'node:crypto';
import type { ChatMessage, LLMProvider } from '../providers/types.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionGate, ApprovalItem, ApprovalResult } from '../tools/permission.js';
import type { DeepcodeConfig } from '../config/types.js';
import type { UsageTracker } from '../usage/extractor.js';
import { runAgentTurn } from './loop.js';
import { estimateMessagesTokens } from './token-budget.js';
import type { EngineEventSink } from '../events.js';

export interface SubagentResult {
  subagentId: string;
  label: string;
  report: string;
  turns: number;
  interrupted: boolean;
  stopReason: string;
  tokensUsed: number;
  error?: string;
}

interface SubagentDeps {
  config: DeepcodeConfig;
  provider: LLMProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  gate: PermissionGate;
  usage: UsageTracker;
  emit: EngineEventSink;
  systemPrompt: string;
  approvalHandler: (items: ApprovalItem[]) => Promise<ApprovalResult>;
  /** Sub-agent working directory (worktree or main workspace) */
  workspace: string;
  signal: AbortSignal;
}

/**
 * Sub-agent runner: independent message context (does not inherit the main session),
 * same tool set, depth limited by the task tool; returns a structured report when done.
 * Concurrency counting is managed by the caller's (SubagentRuntime) closure.
 */
export async function runSubagent(deps: SubagentDeps, opts: { task: string; label: string; depth: number; cwd?: string }): Promise<SubagentResult> {
  const subagentId = randomUUID().slice(0, 8);
  const label = opts.label || `sub-${subagentId}`;
  deps.emit({ type: 'subagent-status', subagentId, label, status: 'running' });

  try {
    const session = {
      id: `sub-${subagentId}`,
      workspace: deps.workspace,
      messages: [] as ChatMessage[],
    };
    const taskPrompt = [
      `You are a sub-agent of deepcode (${label}); here is your task. After completing it, output a concise report:`,
      `# Task`,
      opts.task,
      `\n## Requirements`,
      `- Do only what the task asks; do not expand scope`,
      `- Verify with run_terminal_cmd (build/test)`,
      `- At the end, output ## Report (what changed / verification results / remaining issues)`,
    ].join('\n');

    let errorMsg = '';
    const result = await runAgentTurn(
      {
        config: deps.config,
        provider: deps.provider,
        modelMeta: deps.provider.modelMeta,
        registry: deps.registry,
        executor: deps.executor,
        gate: deps.gate,
        usage: deps.usage,
        session: session as never,
        sessionStore: noopSessionStore as never,
        todoStore: noopTodoStore as never,
        emit: (e) => {
          // forward sub-agent approvals and errors; text/tool details do not pollute the main UI
          if (e.type === 'approval-request') deps.emit(e);
          else if (e.type === 'error') {
            errorMsg = e.message;
            deps.emit(e);
          } else if (e.type === 'usage') deps.emit(e);
        },
        systemPrompt: deps.systemPrompt,
        approvalHandler: deps.approvalHandler,
        signal: deps.signal,
      },
      taskPrompt,
    );

    if (result.stopReason === 'error' && errorMsg) {
      deps.emit({ type: 'subagent-status', subagentId, label, status: 'failed', detail: errorMsg });
      return { subagentId, label, report: '', turns: result.turns, interrupted: result.interrupted, stopReason: 'error', tokensUsed: 0, error: errorMsg };
    }

    // extract the report (last assistant text)
    const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
    const report =
      (typeof lastAssistant?.content === 'string' ? lastAssistant.content : lastAssistant ? JSON.stringify(lastAssistant.content) : '') || '(sub-agent produced no output)';
    deps.emit({ type: 'subagent-status', subagentId, label, status: result.interrupted ? 'failed' : 'done', detail: report.slice(0, 200) });
    return {
      subagentId,
      label,
      report,
      turns: result.turns,
      interrupted: result.interrupted,
      stopReason: result.stopReason,
      tokensUsed: estimateMessagesTokens(result.messages),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.emit({ type: 'subagent-status', subagentId, label, status: 'failed', detail: msg });
    return { subagentId, label, report: '', turns: 0, interrupted: false, stopReason: 'error', tokensUsed: 0, error: msg };
  }
}

const noopSessionStore = {
  create: () => ({ id: 'sub', workspace: '', provider: 'deepseek' as const, model: 'm', title: '', createdAt: 0, updatedAt: 0, messages: [], todos: [], usage: [], compacted: [] }),
  appendMessage: () => undefined,
  appendUsage: () => undefined,
  appendTodo: () => undefined,
  appendCompaction: () => undefined,
  load: () => undefined,
  list: () => [],
  remove: () => undefined,
};

const noopTodoStore = {
  items: [],
  replace: () => undefined,
  get: () => [],
  snapshot: () => [],
  restore: () => undefined,
};
