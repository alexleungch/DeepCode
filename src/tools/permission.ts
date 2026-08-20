import { win32, posix } from 'node:path';
import type { DeepcodeConfig, PermissionMode } from '../config/types.js';

/** Approval item (single call or batch). */
export interface ApprovalItem {
  callId: string;
  toolName: string;
  /** Human-readable action description. */
  description: string;
  /** Command to execute (bash-like). */
  command?: string;
  /** Change diff (file-writing tools). */
  diff?: string;
  /** Path involved. */
  path?: string;
  /** Risk level. */
  risk: 'low' | 'medium' | 'high';
}

export interface ApprovalDecision {
  callId: string;
  action: 'allow' | 'deny' | 'allow-always' | 'deny-always';
  /** Additional user feedback (fed back to the model). */
  feedback?: string;
  /** Tool name; lets remember() record session-level rules without a prior check() registration. */
  toolName?: string;
}

export interface ApprovalResult {
  decisions: ApprovalDecision[];
  /** Whether the whole batch was aborted. */
  aborted: boolean;
}

/** Dangerous command denylist (default; configurable override). */
export const DEFAULT_DENY_PATTERNS: string[] = [
  'rm\\s+-rf\\s+(/|~|\\*|C:\\\\|C:/)',
  'rm\\s+-rf\\s+/',
  'git\\s+push\\s+.*--force',
  'git\\s+push\\s+.*-f\\b',
  'git\\s+reset\\s+--hard\\s+HEAD',
  ':\\s*\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:',
  'mkfs|format\\s+[a-zA-Z]:',
  'shutdown|reboot|poweroff',
  'del\\s+/[sfq]/?\\s+C:\\\\',
  'rd\\s+/[sfq]/?\\s+C:\\\\',
  '>\\s*/dev/sd[a-z]',
  'dd\\s+if=.*of=/dev/sd',
];

/** Keywords for danger-level classification. */
const HIGH_RISK_PATTERNS = [
  /rm\s+-rf/i,
  /git\s+(push|reset|clean|checkout\s+--|rebase)/i,
  /npm\s+(publish|uninstall|rm)/i,
  /pnpm\s+(publish|remove)/i,
  /drop\s+table/i,
  /delete\s+from/i,
  /truncate/i,
  /deploy|release|publish/i,
  /terraform\s+(apply|destroy)/i,
  /kubectl\s+(delete|apply)/i,
  /docker\s+(rm|rmi|system\s+prune)/i,
  /format\s+[a-zA-Z]:/i,
];

export function riskOf(toolName: string, commandOrDesc: string, path?: string): 'low' | 'medium' | 'high' {
  const text = `${toolName} ${commandOrDesc} ${path ?? ''}`;
  if (HIGH_RISK_PATTERNS.some((re) => re.test(text))) return 'high';
  if (toolName === 'run_terminal_cmd' || toolName === 'browser_review') return 'medium';
  if (toolName === 'edit_file' || toolName === 'write_file') return 'medium';
  return 'low';
}

/**
 * Permission gate: Ask by default.
 * - Read-only tools (read_file/glob/grep/todo, etc.) are exempt from approval
 * - Write/execute tools are decided by the permission mode and allow/deny rules
 * - The dangerous-command denylist and out-of-workspace path checks are hard guardrails (bypassPermissions still keeps the denylist, unless explicitly exempted by config)
 */
export class PermissionGate {
  private allowRules: { tool?: string; pattern?: RegExp }[];
  private denyRules: { tool?: string; pattern?: RegExp }[];
  private alwaysAllow: Set<string>;
  private alwaysDeny: Set<string>;
  /** Tool name per callId; only needed until `remember()` consumes it (or the cap evicts it). */
  private toolByCallId = new Map<string, string>();
  /** Upper bound for toolByCallId: auto-approved calls never reach remember(), so keep it small. */
  private static readonly MAX_TRACKED_CALLS = 2_000;

  constructor(
    private config: DeepcodeConfig,
    private workspace: string,
  ) {
    this.allowRules = [];
    this.denyRules = [];
    this.alwaysAllow = new Set();
    this.alwaysDeny = new Set();
    this.parseRules(config.permissions.allow, false);
    this.parseRules(config.permissions.deny, true);
    for (const p of DEFAULT_DENY_PATTERNS) {
      this.denyRules.push({ pattern: new RegExp(p, 'i') });
    }
  }

  private parseRules(rules: string[], isDeny: boolean) {
    for (const rule of rules) {
      const [tool, ...rest] = rule.split(':');
      const patternPart = rest.join(':');
      if (tool && patternPart) {
        try {
          const entry = { tool: tool.trim(), pattern: new RegExp(patternPart.trim(), 'i') };
          if (isDeny) this.denyRules.push(entry);
          else this.allowRules.push(entry);
        } catch {
          // Ignore invalid regex
        }
      } else {
        const toolName = (tool ?? '').trim();
        if (isDeny) this.alwaysDeny.add(toolName);
        else this.alwaysAllow.add(toolName);
      }
    }
  }

  /**
   * Whether the path is inside the workspace (or additionalDirectories).
   * Cross-platform: a Windows drive-letter path (C:\… / C:/…) is compared with win32 semantics
   * even when the host is POSIX — otherwise `C:/outside` would be treated as a relative path and
   * wrongly resolve "inside" the workspace. Non-Windows paths keep the platform semantics.
   */
  isPathAllowed(path: string): boolean {
    const winStyle = /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(this.workspace);
    const p = winStyle ? win32 : posix;
    const abs = p.isAbsolute(path) ? path : p.resolve(this.workspace, path);
    const rel = p.relative(this.workspace, abs);
    if (rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))) return true;
    for (const dir of this.config.permissions.additionalDirectories) {
      const relDir = p.relative(dir, abs);
      if (relDir === '' || (!relDir.startsWith('..') && !p.isAbsolute(relDir))) return true;
    }
    return false;
  }

  /**
   * Decide a single tool call.
   * @returns undefined = manual approval required; otherwise the decision
   */
  check(item: ApprovalItem): ApprovalDecision | undefined {
    const { toolName } = item;
    // Bound the tracker: most calls are auto-approved and never remembered, so an unbounded map
    // would grow for the whole session. Evict the oldest entries (Map preserves insertion order).
    if (this.toolByCallId.size >= PermissionGate.MAX_TRACKED_CALLS) {
      const oldest = this.toolByCallId.keys().next().value;
      if (oldest !== undefined) this.toolByCallId.delete(oldest);
    }
    this.toolByCallId.set(item.callId, toolName);

    // Hard denylist (always deny, unless the user explicitly allowed the same rule and the pattern is in allow)
    for (const rule of this.denyRules) {
      if (rule.tool && rule.tool !== toolName) continue;
      const haystack = `${item.command ?? ''} ${item.description} ${item.path ?? ''}`;
      if (rule.pattern && rule.pattern.test(haystack)) {
        // allow rules can override the denylist for the same tool
        const allowOverride = this.allowRules.some(
          (a) => (a.tool === undefined || a.tool === toolName) && a.pattern && a.pattern.test(haystack),
        );
        if (!allowOverride) return { callId: item.callId, action: 'deny' };
      }
    }

    // Session-level memory
    if (this.alwaysDeny.has(toolName)) return { callId: item.callId, action: 'deny' };
    if (this.alwaysAllow.has(toolName)) return { callId: item.callId, action: 'allow' };

    // Path outside workspace
    if (item.path && !this.isPathAllowed(item.path)) {
      return { callId: item.callId, action: 'deny' };
    }

    // allow rules
    for (const rule of this.allowRules) {
      if (rule.tool && rule.tool !== toolName) continue;
      if (rule.pattern) {
        const haystack = `${item.command ?? ''} ${item.description} ${item.path ?? ''}`;
        if (rule.pattern.test(haystack)) return { callId: item.callId, action: 'allow' };
      }
    }

    const mode = this.config.permissions.mode;
    if (mode === 'bypassPermissions') return { callId: item.callId, action: 'allow' };

    // Read-only tools pass by default (plan mode only allows reads)
    const readTools = new Set(['read_file', 'glob', 'grep', 'todo_write', 'skill', 'memory_search', 'memory_list', 'web_search', 'task']);
    if (readTools.has(toolName)) return { callId: item.callId, action: 'allow' };

    if (mode === 'plan') return { callId: item.callId, action: 'deny' };

    if (mode === 'acceptEdits' && (toolName === 'edit_file' || toolName === 'write_file')) {
      return { callId: item.callId, action: 'allow' };
    }

    // ask mode: manual approval required
    return undefined;
  }

  /** Record a session-level decision ("always allow/deny"). */
  remember(decision: ApprovalDecision): void {
    const tool = decision.toolName ?? this.toolByCallId.get(decision.callId);
    // The callId->tool mapping is single-use: drop it so the tracker does not retain every
    // approved call for the rest of the session.
    this.toolByCallId.delete(decision.callId);
    if (!tool) return;
    if (decision.action === 'allow-always') this.alwaysAllow.add(tool);
    if (decision.action === 'deny-always') this.alwaysDeny.add(tool);
  }

  /** Add an allowed directory (runtime directories such as worktree subagents). */
  addAllowedDir(dir: string): void {
    if (!this.config.permissions.additionalDirectories.includes(dir)) {
      this.config.permissions.additionalDirectories.push(dir);
    }
  }
}

