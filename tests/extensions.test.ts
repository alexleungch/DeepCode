import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcpServer } from '../src/tools/mcp/client.js';
import { createWorktree, mergeWorktree, worktreeSummary, discardWorktree } from '../src/git/worktree.js';
import { runSubagent } from '../src/agent/subagent.js';
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent } from '../src/providers/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { PermissionGate } from '../src/tools/permission.js';
import { UsageTracker } from '../src/usage/extractor.js';
import { defaultConfig } from '../src/config/defaults.js';
import type { ToolContext } from '../src/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p5-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('MCP integration (stdio fake server)', () => {
  it('connect -> tool registration -> call echo', async () => {
    const serverPath = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
    const r = await connectMcpServer('fake', { command: process.execPath, args: [serverPath] });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.tools).toHaveLength(1);
    const echo = r.tools[0]!;
    expect(echo.name).toBe('mcp__fake__echo');
    const ctx: ToolContext = {
      cwd: dir,
      workspace: dir,
      sessionId: 's',
      config: defaultConfig(),
      permissionMode: 'ask',
      askApproval: async () => [],
      askApprovalBatch: async () => ({ decisions: [], aborted: false }),
      emit: () => undefined,
      signal: new AbortController().signal,
    };
    const result = await echo.execute({ text: 'hello mcp' }, ctx);
    expect(result.content).toContain('echo: hello mcp');
    await r.close();
  });

  it('connection failure returns error (non-blocking)', async () => {
    const r = await connectMcpServer('bad', { command: 'definitely-not-a-command-xyz' });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('connection failed');
  });
});

describe('worktree isolation', () => {
  it('clean repo: create -> commit -> merge -> cleanup', async () => {
    // initialize a temporary git repo
    const { simpleGit } = await import('simple-git');
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig('user.email', 't@t.co');
    await git.addConfig('user.name', 'test');
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    await git.add('.');
    await git.commit('init');

    const wt = await createWorktree(repoDir, 'job1');
    expect(wt).not.toBeNull();
    if (!wt) return;
    expect(existsSync(join(wt.path, 'base.txt'))).toBe(true);

    // commit on the sub-branch
    const wtGit = wt.git;
    writeFileSync(join(wt.path, 'feature.txt'), 'feature\n');
    await wtGit.add('.');
    await wtGit.commit('feat');

    const summary = await worktreeSummary(wt);
    expect(summary.commits).toBeGreaterThan(0);
    expect(summary.diffStat).toContain('feature.txt');

    const merged = await mergeWorktree(repoDir, wt, 'merge job1');
    expect(merged.ok).toBe(true);
    // the main branch contains the feature file
    expect(existsSync(join(repoDir, 'feature.txt'))).toBe(true);
    // worktree cleaned up
    expect(existsSync(wt.path)).toBe(false);
  });

  it('dirty workspace returns null (in-place execution fallback)', async () => {
    const { simpleGit } = await import('simple-git');
    const repoDir = join(dir, 'dirty');
    mkdirSync(repoDir, { recursive: true });
    const git = simpleGit(repoDir);
    await git.init();
    writeFileSync(join(repoDir, 'x.txt'), 'x');
    await git.add('.');
    await git.commit('init');
    writeFileSync(join(repoDir, 'dirty.txt'), 'dirty');
    const wt = await createWorktree(repoDir, 'job2');
    expect(wt).toBeNull();
  });

  it('non-git directory returns null', async () => {
    const wt = await createWorktree(join(dir, 'norepo'), 'job3');
    expect(wt).toBeNull();
  });

  it('discardWorktree cleans up', async () => {
    const { simpleGit } = await import('simple-git');
    const repoDir = join(dir, 'discard');
    mkdirSync(repoDir, { recursive: true });
    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig('user.email', 't@t.co');
    await git.addConfig('user.name', 'test');
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    await git.add('.');
    await git.commit('init');
    const wt = await createWorktree(repoDir, 'job4');
    expect(wt).not.toBeNull();
    if (!wt) return;
    await discardWorktree(repoDir, wt);
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe('subagent (fake provider script)', () => {
  const scriptedProvider = (): LLMProvider => ({
    id: 'deepseek',
    model: 'deepseek-chat',
    modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
    async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
      yield {
        type: 'done',
        response: {
          message: { role: 'assistant', content: [{ type: 'text', text: '## Report\nTask completed' }] },
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end_turn',
        },
      };
    },
    async complete() {
      throw new Error('not used');
    },
  });

  it('runSubagent runs in an isolated context and returns a report', async () => {
    const registry = new ToolRegistry();
    const config = defaultConfig();
    const events: string[] = [];
    const result = await runSubagent(
      {
        config,
        provider: scriptedProvider(),
        registry,
        executor: new ToolExecutor(registry),
        gate: new PermissionGate(config, dir),
        usage: new UsageTracker(),
        emit: (e) => {
          if (e.type === 'subagent-status') events.push(`${e.label}:${e.status}`);
        },
        systemPrompt: 'sys',
        approvalHandler: async () => ({ decisions: [], aborted: false }),
        workspace: dir,
        signal: new AbortController().signal,
      },
      { task: 'write tests', label: 'tester', depth: 1 },
    );
    expect(result.report).toContain('Task completed');
    expect(result.turns).toBe(1);
    expect(events).toContain('tester:running');
    expect(events).toContain('tester:done');
  });

  it('subagent failure -> failed status + error field', async () => {
    const provider: LLMProvider = {
      id: 'deepseek',
      model: 'deepseek-chat',
      modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
      async *stream(): AsyncIterable<LLMStreamEvent> {
        throw new Error('model crashed');
      },
      async complete() {
        throw new Error('not used');
      },
    };
    const registry = new ToolRegistry();
    const config = defaultConfig();
    const result = await runSubagent(
      {
        config,
        provider,
        registry,
        executor: new ToolExecutor(registry),
        gate: new PermissionGate(config, dir),
        usage: new UsageTracker(),
        emit: () => undefined,
        systemPrompt: 'sys',
        approvalHandler: async () => ({ decisions: [], aborted: false }),
        workspace: dir,
        signal: new AbortController().signal,
      },
      { task: 'x', label: 'boom', depth: 1 },
    );
    expect(result.stopReason).toBe('error');
    expect(result.error).toBeTruthy();
  });
});
