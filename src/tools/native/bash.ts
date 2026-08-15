import { spawn } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult, ToolPreview } from '../types.js';

export const bashSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().max(600_000).optional(),
  cwd: z.string().optional(),
  background: z.boolean().optional(),
});

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT = 120_000;

export function makeBashTool(workspace: string): ToolDef {
  return {
    name: 'run_terminal_cmd',
    description:
      'Execute a Shell command in the terminal (npm test, git status, builds, etc.). Non-zero exit codes are returned as errors for self-correction.' +
      'Commands are killed automatically on timeout. Windows uses cmd.exe, Unix-like systems use /bin/sh.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'integer', minimum: 1000, maximum: 600000, description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT})` },
        cwd: { type: 'string', description: 'Working directory (defaults to the session workspace)' },
        background: { type: 'boolean', description: 'Run in background (returns immediately, logs written to a file)' },
      },
      required: ['command'],
    },
    permission: 'execute',
    async preview(input: unknown): Promise<ToolPreview> {
      const parsed = bashSchema.safeParse(input);
      if (!parsed.success) {
        return { description: `run_terminal_cmd (invalid arguments: ${parsed.error.issues[0]?.message ?? ''})` };
      }
      return { description: `Execute command`, command: parsed.data.command };
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = bashSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `run_terminal_cmd invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { command, timeout = ctx.config.agent.toolTimeoutMs ?? DEFAULT_TIMEOUT, cwd, background } = parsed.data;
      const runCwd = cwd ? (isAbsolute(cwd) ? cwd : resolve(ctx.cwd, cwd)) : ctx.cwd;

      if (background) {
        const outFile = `${ctx.sessionId}.bg.log`;
        const child = spawn(command, { shell: true, cwd: runCwd, stdio: 'ignore', detached: true });
        child.unref();
        return { content: `Background execution started: ${command}\n(pid ${child.pid ?? '?'}; output not captured)` };
      }

      return new Promise<ToolResult>((resolvePromise) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          resolvePromise(result);
        };

        const child = spawn(command, { shell: true, cwd: runCwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
          child.kill();
          finish({
            content: `Command timed out (${timeout}ms) and was killed: ${command}\n--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}`,
            isError: true,
          });
        }, timeout);

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.length < MAX_OUTPUT_CHARS) {
            ctx.emit({ type: 'tool-progress', callId: '', text: chunk.toString() });
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          ctx.emit({ type: 'tool-progress', callId: '', text: chunk.toString() });
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          finish({ content: `Failed to start the command: ${e.message}`, isError: true });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const killed = signal ? ` (killed by signal ${signal})` : '';
          const ok = code === 0;
          const content = [
            `$ ${command}`,
            ok || !stdout ? '' : `--- stdout ---\n${truncate(stdout)}`,
            stderr ? `--- stderr ---\n${truncate(stderr)}` : '',
            `[exit code: ${code}${killed ? ', ' + killed : ''}]`,
          ]
            .filter((s) => s !== '')
            .join('\n');
          finish({
            content: ok && !stderr ? `$ ${command}\n${truncate(stdout).trim()}\n[exit code: 0]` : content,
            isError: !ok,
          });
        });
      });
    },
  };
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n… (output truncated, ${s.length} chars total)` : s;
}
