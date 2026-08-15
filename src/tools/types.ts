import type { ApprovalItem, ApprovalDecision, ApprovalResult } from './permission.js';
import type { EngineEvent } from '../events.js';
import type { DeepcodeConfig, PermissionMode } from '../config/types.js';
import type { LLMProvider } from '../providers/types.js';
import type { ToolRegistry } from './registry.js';
import type { ToolExecutor } from './executor.js';
import type { PermissionGate } from './permission.js';
import type { UsageTracker } from '../usage/extractor.js';
import type { SubagentResult } from '../agent/subagent.js';

/** Tool artifact (file path, etc.). */
export interface ToolArtifact {
  path: string;
}

/** Tool execution result (Observation). */
export interface ToolResult {
  content: string;
  isError?: boolean;
  diff?: string;
  truncated?: boolean;
  artifacts?: ToolArtifact[];
  /** Additional images (for vision injection, e.g. browser_review screenshots). */
  images?: { mediaType: string; base64: string }[];
  /** Metadata visible to subsequent LLM requests. */
  meta?: Record<string, unknown>;
}

/** Subagent runtime (injected by the engine; used by the task tool). */
export interface SubagentRuntime {
  activeCount: number;
  spawn(opts: { task: string; label: string; depth: number; workspace: string }): Promise<SubagentResult>;
}

/** Tool execution context (injected by the agent loop). */
export interface ToolContext {
  cwd: string;
  workspace: string;
  sessionId: string;
  config: DeepcodeConfig;
  permissionMode: PermissionMode;
  /** Request approval (Ask mode); batch approval returns per-item decisions. */
  askApproval(items: ApprovalItem[]): Promise<ApprovalDecision[]>;
  /** Full approval (including aborted semantics; reused by subagents). */
  askApprovalBatch(items: ApprovalItem[]): Promise<ApprovalResult>;
  /** Emit an event to the render layer. */
  emit(event: EngineEvent): void;
  /** Abort signal (ESC interruption). */
  signal: AbortSignal;
  /** Subagent runtime (task tool). */
  subagents?: SubagentRuntime;
  /** Current subagent depth. */
  subagentDepth?: number;
  /** Add an allowed directory (worktree isolation directory). */
  addAllowedDir?: (dir: string) => void;
  /** Optional cleanup hook for running tools. */
  onAbort?: (callId: string) => void;
}

/** Approval preview (shown to the user before a write operation executes). */
export interface ToolPreview {
  description: string;
  command?: string;
  diff?: string;
  path?: string;
}

/** Tool definition (registered uniformly by the registry: native / plugin / mcp). */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07 subset). */
  inputSchema: Record<string, unknown>;
  /** Permission category: read is exempt; write/execute/ask go through the gate. */
  permission: 'read' | 'write' | 'execute' | 'ask';
  /** Execution implementation. */
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  /** Change preview before approval (optional; recommended for write/execute tools). */
  preview?(input: unknown, ctx: ToolContext): Promise<ToolPreview>;
}
