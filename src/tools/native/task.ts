import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';
import { createWorktree, mergeWorktree, worktreeSummary, discardWorktree, type WorktreeHandle } from '../../git/worktree.js';

export const taskSchema = z.object({
  task: z.string().min(1),
  label: z.string().optional(),
  worktree: z.boolean().optional(),
});

/**
 * task: spawn a subagent to complete a task independently (supports Git Worktree isolation).
 * Depth/concurrency are controlled by the SubagentRuntime injected by the engine.
 */
export function makeTaskTool(): ToolDef {
  return {
    name: 'task',
    description:
      'Spawn a subagent to complete a task in an independent context (multiple can run in parallel). Good for splitting off standalone subtasks (e.g. "update the tests").' +
      'When the git repo is clean, the subagent works on a temporary worktree branch; merging requires approval when done.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete description of the subtask (self-contained, must not rely on the parent session context)' },
        label: { type: 'string', description: 'Subagent label (for display)' },
        worktree: { type: 'boolean', description: 'Force/forbid worktree isolation (default: auto per config)' },
      },
      required: ['task'],
    },
    permission: 'execute',
    async preview(input: unknown): Promise<{ description: string }> {
      const parsed = taskSchema.safeParse(input);
      if (!parsed.success) return { description: `task (invalid arguments: ${parsed.error.issues[0]?.message ?? ''})` };
      return { description: `Spawn subagent: ${parsed.data.label ?? parsed.data.task.slice(0, 40)}` };
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = taskSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `task invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { task, label, worktree } = parsed.data;
      if (!ctx.subagents) {
        return { content: 'Subagents are not enabled (config.subagents.enabled=false)', isError: true };
      }
      const depth = ctx.subagentDepth ?? 0;
      const maxDepth = ctx.config.subagents.maxDepth;
      if (depth >= maxDepth) {
        return { content: `Subagent depth limit reached (${maxDepth}); cannot spawn further`, isError: true };
      }
      const subLabel = label ?? task.slice(0, 30);

      // worktree decision
      const wtMode = worktree === false ? 'off' : worktree === true ? 'on' : ctx.config.subagents.worktree;
      let wt: WorktreeHandle | null = null;
      let workDir = ctx.cwd;
      if (wtMode !== 'off') {
        wt = await createWorktree(ctx.cwd, `${ctx.sessionId}-${Date.now().toString(36).slice(-4)}`);
        if (wt) {
          workDir = wt.path;
          ctx.addAllowedDir?.(wt.path);
          ctx.emit({ type: 'subagent-status', subagentId: 'wt', label: `worktree ${wt.branch}`, status: 'running', detail: wt.path });
        }
      }

      const result = await ctx.subagents.spawn({ task, label: subLabel, depth: depth + 1, workspace: workDir });

      // worktree merge flow (approval)
      let mergeNote = '';
      if (wt) {
        try {
          const summary = await worktreeSummary(wt);
          if (summary.commits > 0 || summary.diffStat) {
            const [decision] = await ctx.askApproval([
              {
                callId: `merge-${result.subagentId}`,
                toolName: 'task',
                description: `Merge subagent branch ${wt.branch} into the main branch?\n${summary.diffStat.slice(0, 2000)}`,
                risk: 'medium',
              },
            ]);
            if (decision?.action === 'allow' || decision?.action === 'allow-always') {
              const merged = await mergeWorktree(ctx.cwd, wt, `deepcode: merge ${subLabel}`);
              if (merged.ok) {
                mergeNote = `\n✅ Merged ${wt.branch} and cleaned up the worktree`;
                ctx.emit({ type: 'subagent-status', subagentId: result.subagentId, label: subLabel, status: 'merged' });
              } else {
                mergeNote = `\n⚠️ Merge failed (${merged.error}); worktree kept at ${wt.path}`;
              }
            } else {
              mergeNote = `\nMerge rejected; worktree kept at ${wt.path} (clean it up with git worktree remove)`;
            }
          } else {
            await discardWorktree(ctx.cwd, wt);
            mergeNote = '\n(no commits from the subagent; worktree cleaned up)';
          }
        } catch (e) {
          mergeNote = `\n⚠️ worktree handling error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      if (result.error) {
        return { content: `Subagent ${subLabel} execution failed: ${result.error}${mergeNote}`, isError: true };
      }
      return {
        content: `# Subagent report (${subLabel}, ${result.turns} turns, ${result.tokensUsed} tokens)\n${result.report}${mergeNote}`,
      };
    },
  };
}
