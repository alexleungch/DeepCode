import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';

/**
 * Orchestrator & Sub-Agent pattern: `run_subtasks` lets the main agent (orchestrator) split a large
 * task into several INDEPENDENT subtasks and dispatch them all in ONE tool call. The sub-agents run
 * in parallel (bounded by config.subagents.maxConcurrent), each with its own turn budget
 * (config.subagents.maxTurns) that does NOT consume the main agent's counter. The orchestrator
 * stays at a low turn count: it only plans, dispatches, and merges the reports.
 */
const subtasksSchema = z.object({
  tasks: z
    .array(
      z.object({
        task: z.string().min(1).describe('Complete, self-contained description of the subtask (must not rely on the parent session context)'),
        label: z.string().optional().describe('Short label for the subagent (for display in the status bar / notices)'),
      }),
    )
    .min(1)
    .max(16)
    .describe('List of independent subtasks to run in parallel'),
  worktree: z.boolean().optional().describe('Force/forbid worktree isolation for all subtasks (default: auto per config)'),
});

export function makeSubtasksTool(): ToolDef {
  return {
    name: 'run_subtasks',
    description:
      'Orchestrator mode: split a large task into several INDEPENDENT subtasks and dispatch them in ONE call. ' +
      'Sub-agents run in PARALLEL (bounded by config.subagents.maxConcurrent); each has its own turn budget that does not consume the main loop. ' +
      'Returns a combined report per subtask. Use this when a big job decomposes into independent pieces ' +
      '(e.g. "update the tests", "reproduce bug A", "scan module B") instead of doing them turn-by-turn yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Complete, self-contained description of the subtask (must not rely on the parent session context)' },
              label: { type: 'string', description: 'Short label for the subagent (for display)' },
            },
            required: ['task'],
          },
          minItems: 1,
          maxItems: 16,
          description: 'List of independent subtasks to run in parallel',
        },
        worktree: { type: 'boolean', description: 'Force/forbid worktree isolation for all subtasks (default: auto per config)' },
      },
      required: ['tasks'],
    },
    permission: 'execute',
    async preview(input: unknown): Promise<{ description: string }> {
      const parsed = subtasksSchema.safeParse(input);
      if (!parsed.success) return { description: `run_subtasks (invalid arguments: ${parsed.error.issues[0]?.message ?? ''})` };
      return { description: `Dispatch ${parsed.data.tasks.length} subtasks in parallel` };
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = subtasksSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `run_subtasks invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      if (!ctx.subagents) {
        return { content: 'Subagents are not enabled (config.subagents.enabled=false)', isError: true };
      }
      const depth = ctx.subagentDepth ?? 0;
      const maxDepth = ctx.config.subagents.maxDepth;
      if (depth >= maxDepth) {
        return { content: `Subagent depth limit reached (${maxDepth}); cannot spawn subtasks`, isError: true };
      }
      const { tasks, worktree } = parsed.data;
      const maxConcurrent = Math.max(1, ctx.config.subagents.maxConcurrent);
      const wtMode = worktree === false ? 'off' : worktree === true ? 'on' : ctx.config.subagents.worktree;

      // Worktree isolation: create one shared worktree for all subtasks (they are independent but
      // often need a scratch space). Kept simple: one worktree, all subtasks run in it.
      let workDir = ctx.cwd;
      if (wtMode !== 'off') {
        const { createWorktree } = await import('../../git/worktree.js');
        const wt = await createWorktree(ctx.cwd, `${ctx.sessionId}-${Date.now().toString(36).slice(-4)}`);
        if (wt) {
          workDir = wt.path;
          ctx.addAllowedDir?.(wt.path);
          ctx.emit({ type: 'subagent-status', subagentId: 'wt', label: `worktree ${wt.branch}`, status: 'running', detail: wt.path });
        }
      }

      // Dispatch in waves of maxConcurrent so every subtask actually runs (the runtime rejects
      // spawns beyond the concurrency cap).
      const results: { label: string; report: string; turns: number; tokensUsed: number; error?: string; interrupted: boolean }[] = [];
      for (let i = 0; i < tasks.length; i += maxConcurrent) {
        const wave = tasks.slice(i, i + maxConcurrent);
        const waveResults = await Promise.all(
          wave.map(async (t) => {
            const label = t.label ?? t.task.slice(0, 30);
            const r = await ctx.subagents!.spawn({ task: t.task, label, depth: depth + 1, workspace: workDir });
            return {
              label,
              report: r.report,
              turns: r.turns,
              tokensUsed: r.tokensUsed,
              error: r.error,
              interrupted: r.interrupted,
            };
          }),
        );
        results.push(...waveResults);
      }

      // Compose a per-subtask report for the orchestrator to merge.
      const lines: string[] = [`# Subtask results (${results.length} subtasks)`];
      let failed = 0;
      for (const r of results) {
        if (r.error) failed++;
        lines.push('', `## ${r.label} — ${r.error ? 'FAILED' : 'done'} (${r.turns} turns, ${r.tokensUsed} tokens)`);
        if (r.error) lines.push(`Error: ${r.error}`);
        else lines.push(r.report.trim() || '(no output)');
      }
      if (failed > 0) {
        lines.push('', `⚠ ${failed}/${results.length} subtasks failed — review the errors above before proceeding.`);
      }
      return { content: lines.join('\n'), isError: failed > 0 };
    },
  };
}
