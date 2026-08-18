import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { DeepcodeConfig, PermissionMode, ProviderId } from './config/types.js';
import { API_KEY_ENV, type ResolvedConfig } from './config/loader.js';
import { createProvider } from './providers/factory.js';
import type { LLMProvider } from './providers/types.js';
import { resolveTheme, setActiveThemeId, applyTheme, currentThemeId } from './ui/themes.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolExecutor } from './tools/executor.js';
import { PermissionGate, type ApprovalItem, type ApprovalResult } from './tools/permission.js';
import { registerNativeTools } from './tools/native/index.js';
import { TodoStore } from './tools/native/todo.js';
import { SessionStore } from './session/store.js';
import type { SessionRecord } from './session/types.js';
import { UsageTracker, type UsageEvent } from './usage/extractor.js';
import { UsageStore } from './usage/store.js';
import { pricingFor } from './config/defaults.js';
import { buildSystemPrompt } from './agent/system-prompt.js';
import { runAgentTurn, type TurnResult } from './agent/loop.js';
import { compressMessages } from './agent/compressor.js';
import { estimateMessagesTokens } from './agent/token-budget.js';
import { detectRepo } from './git/repo.js';
import { makeBrowserReviewTool } from './tools/native/browser/review.js';
import { makeSkillTool } from './tools/native/skill.js';
import { makeTaskTool } from './tools/native/task.js';
import { connectMcpServer } from './tools/mcp/client.js';
import { SkillLoader, skillsCatalog } from './skills/loader.js';
import type { Skill } from './skills/types.js';
import { PluginLoader } from './plugins/loader.js';
import type { Plugin } from './plugins/types.js';
import { runSubagent, type SubagentResult } from './agent/subagent.js';
import { MemoryDb } from './memory/db.js';
import { MemoryPipeline } from './memory/pipeline.js';
import { makeMemoryTools } from './memory/tools.js';
import type { SubagentRuntime, ToolContext } from './tools/types.js';
import type { EngineEvent, EngineEventSink } from './events.js';

export interface EngineOptions {
  resolved: ResolvedConfig;
  /** Permission mode override (CLI flag) */
  permissionMode?: PermissionMode;
  /** Resumed session (--continue/--resume) */
  resumeSession?: SessionRecord;
  /** Approval handler; defaults to CLI interaction on stdin */
  approvalHandler?: (items: ApprovalItem[]) => Promise<ApprovalResult>;
  /** Skills catalog (P5 injection) */
  skillsCatalog?: string;
  /** Memory digest (P6 injection) */
  memoryDigest?: string;
  /** Extra tools (browser_review/skill/task/memory etc. injected by later phases) */
  extraTools?: import('./tools/types.js').ToolDef[];
  /** Session title */
  title?: string;
  /** Abort signal (ESC interrupt) */
  signal?: AbortSignal;
  /** Fact extraction for compacted turns (P6 Agent Memory integration) */
  extractFacts?: (turns: import('./providers/types.js').ChatMessage[]) => import('./agent/compressor.js').MemoryExtraction[];
}

/**
 * Engine assembly: composes config/providers/tools/gate/usage/session into a runnable unit.
 * Render layers (TUI / --print) only subscribe to emit.
 */
export class DeepcodeEngine {
  readonly config: DeepcodeConfig;
  provider: LLMProvider;
  readonly registry = new ToolRegistry();
  readonly executor: ToolExecutor;
  readonly gate: PermissionGate;
  readonly usage: UsageTracker;
  readonly usageStore: UsageStore;
  readonly sessionStore: SessionStore;
  readonly todoStore = new TodoStore();
  readonly session: SessionRecord;
  readonly workspace: string;
  readonly systemPrompt: string;
  readonly resumeId?: string;

  private listeners: EngineEventSink[] = [];
  private opts: EngineOptions;
  private closed = false;
  /** Global process/interrupt signal shared by all runs (subagents). Retained for compatibility. */
  private abortController = new AbortController();
  /** True while a top-level turn (runTurn) is in flight, so Ctrl+C can abandon that turn's approval */
  private turnInFlight = false;
  /** Per-turn interrupt: set by the first interrupt() call while a turn is in flight, reset on
   *  the next runTurn(). This is what lets ESC interrupt the CURRENT turn (and its tools) without
   *  poisoning later turns — a bare interrupt() when nothing is running is a no-op. */
  private interruptRequested = false;
  private approvalHandlerOverride?: (items: ApprovalItem[]) => Promise<ApprovalResult>;
  private mcpCleanups: (() => Promise<void>)[] = [];
  private subagentRuntime: SubagentRuntime = { activeCount: 0, spawn: async () => ({ subagentId: '', label: '', report: 'Subagent not initialized', turns: 0, interrupted: false, stopReason: 'error', tokensUsed: 0, error: 'Subagent not initialized' }) };
  skills: Skill[] = [];
  plugins: Plugin[] = [];
  memoryDb?: MemoryDb;
  memoryPipeline?: MemoryPipeline;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    const { resolved } = opts;
    this.config = resolved.config;
    if (opts.permissionMode) this.config.permissions.mode = opts.permissionMode;
    this.workspace = resolved.workspace;

    // provider
    this.provider = createProvider(this.config, this.config.provider, resolved.model);

    // gate / registry / executor
    this.gate = new PermissionGate(this.config, this.workspace);
    const extra = [...(opts.extraTools ?? [])];
    // browser_review (real rendering checks) is always registered
    extra.push(makeBrowserReviewTool({ workspace: this.workspace, screenshotsDir: resolved.paths.screenshotsDir }));
    registerNativeTools(this.registry, { workspace: this.workspace, todoStore: this.todoStore, extra });
    this.executor = new ToolExecutor(this.registry);

    // usage
    this.usageStore = new UsageStore(resolved.paths.usageDbPath, resolved.paths.logsDir);
    this.usage = new UsageTracker({
      pricing: (m) => pricingFor(this.config, m),
      onEvent: (e) => this.persistUsage(e),
    });

    // session
    this.sessionStore = new SessionStore(resolved.paths.sessionsDir);
    if (opts.resumeSession) {
      this.session = opts.resumeSession;
      this.resumeId = opts.resumeSession.id;
      this.todoStore.restore(opts.resumeSession.todos);
    } else {
      this.session = this.sessionStore.create({
        workspace: this.workspace,
        provider: this.config.provider,
        model: resolved.model,
        title: opts.title ?? 'deepcode session',
      });
    }

    // system prompt (stable prefix; rebuilt once in init after project docs are merged)
    this.systemPrompt = buildSystemPrompt({
      config: this.config,
      workspace: this.workspace,
      model: resolved.model,
      providerLabel: providerLabel(this.config.provider),
      tools: this.registry.schemas(),
      projectDocs: [],
      skillsCatalog: opts.skillsCatalog,
      memoryDigest: opts.memoryDigest,
      userPromptFile: resolved.paths.systemPromptFile,
    });
  }

  /** Async initialization: assembles skills/plugins/MCP/subagents, probes the repo, then rebuilds the system prompt */
  async init(): Promise<void> {
    const repo = await detectRepo(this.workspace);

    // -- skills (user-level + project-level + repo builtin skills/ directory) --
    if (this.config.skills.enabled) {
      const loader = new SkillLoader(this.opts.resolved.paths.userSkillsDir, this.config.skills, [
        joinBuiltinDir(this.workspace, 'skills'),
      ]);
      this.skills = await loader.loadAll(this.opts.resolved.paths.projectDir);
    }

    // -- plugins (with embedded skills and mcpServers) --
    this.plugins = [];
    if (this.config.plugins.enabled) {
      const loader = new PluginLoader(this.opts.resolved.paths.userPluginsDir, this.config.plugins);
      this.plugins = await loader.loadAll();
      for (const p of this.plugins) {
        for (const tool of p.tools) {
          try {
            this.registry.register(tool);
          } catch (e) {
            this.emit({ type: 'error', message: `Failed to register tools for plugin ${p.id}: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
      }
    }

    // -- skill tool + task tool (registered after plugin tools for a stable order) --
    const skillTool = makeSkillTool({ getSkills: async () => this.skills });
    this.registry.register(skillTool);
    const taskTool = makeTaskTool();
    this.registry.register(taskTool);

    // -- Agent Memory (SQLite four-layer; zero external dependencies) --
    let memoryDigest = this.opts.memoryDigest;
    if (this.config.memory.enabled) {
      this.memoryDb = new MemoryDb(this.opts.resolved.paths.memoryDbPath, this.opts.resolved.paths.dataDir);
      this.memoryPipeline = new MemoryPipeline(this.memoryDb, this.workspace);
      for (const t of makeMemoryTools({ db: this.memoryDb, pipeline: this.memoryPipeline, workspace: this.workspace })) {
        this.registry.register(t);
      }
      // Session start: retrieve relevant memories into the system prompt (stable within the session, keeps the cache prefix intact)
      const probe = repo.projectDocs.join(' ') || this.workspace.split(/[\\/]/).pop() || 'deepcode';
      memoryDigest = this.memoryPipeline.digest(probe, this.config.memory.injectTopK) || this.opts.memoryDigest;
    }

    // -- MCP servers --
    const allMcp = { ...this.config.mcpServers };
    for (const p of this.plugins) Object.assign(allMcp, p.mcpServers);
    this.mcpCleanups = [];
    for (const [name, cfg] of Object.entries(allMcp).sort()) {
      const r = await connectMcpServer(name, cfg);
      if ('error' in r) {
        this.emit({ type: 'error', message: r.error });
        continue;
      }
      for (const tool of r.tools) this.registry.registerOrReplace(tool);
      this.mcpCleanups.push(r.close);
    }

    // -- subagent runtime (concurrency counter managed by a closure) --
    this.subagentRuntime = (() => {
      let activeCount = 0;
      return {
        get activeCount() {
          return activeCount;
        },
        spawn: async (opts): Promise<SubagentResult> => {
          if (activeCount >= this.config.subagents.maxConcurrent) {
            return {
              subagentId: '',
              label: opts.label,
              report: '',
              turns: 0,
              interrupted: false,
              stopReason: 'error',
              tokensUsed: 0,
              error: `Subagent concurrency limit reached (${this.config.subagents.maxConcurrent}); try again later`,
            };
          }
          activeCount++;
          try {
            return await runSubagent(
              {
                config: this.config,
                provider: this.provider,
                registry: this.registry,
                executor: this.executor,
                gate: this.gate,
                usage: this.usage,
                emit: (e) => this.emit(e),
                systemPrompt: this.systemPrompt,
                approvalHandler: this.approvalHandlerOverride ?? this.opts.approvalHandler ?? this.defaultApprovalHandler,
                workspace: opts.workspace,
                signal: this.abortController.signal,
              },
              opts,
            );
          } finally {
            activeCount--;
          }
        },
      };
    })();

    // -- rebuild the system prompt (with project docs and the skills catalog) --
    const rebuilt = buildSystemPrompt({
      config: this.config,
      workspace: this.workspace,
      model: this.provider.model,
      providerLabel: providerLabel(this.config.provider),
      tools: this.registry.schemas(),
      projectDocs: repo.projectDocs,
      skillsCatalog: this.skills.length ? skillsCatalog(this.skills) : this.opts.skillsCatalog,
      memoryDigest,
      userPromptFile: this.opts.resolved.paths.systemPromptFile,
    });
    (this as { systemPrompt: string }).systemPrompt = rebuilt;
    this.emit({ type: 'session-start', sessionId: this.session.id, provider: this.config.provider, model: this.provider.model, workspace: this.workspace, branch: repo.branch, resumed: !!this.opts.resumeSession });
  }

  emit(event: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // render-layer exceptions must not affect the engine
      }
    }
  }

  onEvent(listener: EngineEventSink): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Default approval handler (non-TTY denies; TTY uses CLI interaction) */
  defaultApprovalHandler: (items: ApprovalItem[]) => Promise<ApprovalResult> = async (items) => {
    if (!process.stdin.isTTY) {
      return { decisions: items.map((i) => ({ callId: i.callId, action: 'deny' as const })), aborted: false };
    }
    return cliApproval(items);
  };

  /** Approval handler registration (TUI dialogs use this); undefined falls back to the default stdin handler */
  setApprovalHandler(handler: ((items: ApprovalItem[]) => Promise<ApprovalResult>) | undefined): void {
    this.approvalHandlerOverride = handler;
  }

  /** Abandon any approval wait belonging to the in-flight turn (Ctrl+C while the dialog is open).
   *  Returns false when there is no running turn to abandon, so callers know to treat Ctrl+C as
   *  a graceful exit instead. */
  abandonApproval(): boolean {
    if (!this.turnInFlight) return false;
    // The abort signal is what the loop's catch treats as "interrupted"; the approval promise in
    // the TUI dialog listens to the same engine.interrupt() path via the app's abortAll().
    // Triggering the interrupt signal here ensures runToolCalls treats the pending batch as aborted.
    this.interrupt();
    return true;
  }

  /** Interrupt the current request (ESC) */
  interrupt(): void {
    if (this.interruptRequested) return;
    this.interruptRequested = true;
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * Switch the permission mode (plan / ask / acceptEdits / bypassPermissions).
   *  Session-scoped: the mode is not persisted, so a restart returns to the configured default.
   *  The system prompt is rebuilt so the model knows its constraints (e.g. plan mode = read-only). */
  setMode(mode: PermissionMode): void {
    this.config.permissions.mode = mode;
    (this as { systemPrompt: string }).systemPrompt = buildSystemPrompt({
      config: this.config,
      workspace: this.workspace,
      model: this.provider.model,
      providerLabel: providerLabel(this.config.provider),
      tools: this.registry.schemas(),
      projectDocs: [],
      userPromptFile: this.opts.resolved.paths.systemPromptFile,
    });
  }

  /**
   * Switch the TUI theme. Updates the live config and the runtime palette; when
   * `persist` is set the id is written to the user-level config file
   * (~/.deepcode/config.json) so it survives restarts.
   */
  setTheme(id: string, persist?: boolean): void {
    const theme = resolveTheme(id);
    this.config.ui = { ...this.config.ui, theme: theme.id };
    // Runtime palette switch: applyTheme() copies the palette into the shared
    // themeColors object in place, so every component that imported `theme`
    // from theme.ts picks up the new colors on the next render.
    setActiveThemeId(theme.id);
    applyTheme(currentThemeId());
    if (persist) {
      const file = join(this.opts.resolved.paths.dataDir, 'config.json');
      try {
        const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
        existing.ui = { ...((existing.ui as Record<string, unknown> | undefined) ?? {}), theme: theme.id };
        writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
      } catch (e) {
        throw new Error(`Failed to persist theme to ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Switch the model (rebuilds the provider and the system prompt) */
  setModel(model: string): void {
    this.provider = createProvider(this.config, this.config.provider, model);
    (this as { systemPrompt: string }).systemPrompt = buildSystemPrompt({
      config: this.config,
      workspace: this.workspace,
      model,
      providerLabel: providerLabel(this.config.provider),
      tools: this.registry.schemas(),
      projectDocs: [],
      userPromptFile: this.opts.resolved.paths.systemPromptFile,
    });
    this.session.model = model;
  }

  /** Switch the provider (optionally with a specific model; defaults to the provider's configured model).
   *  When `persist` is set, the provider + model selection is written to ~/.deepcode/config.json. */
  setProvider(providerId: ProviderId, model?: string, persist?: boolean): void {
    const pid = providerId;
    const modelId = model ?? this.config.models[pid] ?? 'unknown-model';
    this.config.provider = pid;
    this.config.models[pid] = modelId;
    this.provider = createProvider(this.config, pid, modelId);
    (this as { systemPrompt: string }).systemPrompt = buildSystemPrompt({
      config: this.config,
      workspace: this.workspace,
      model: modelId,
      providerLabel: providerLabel(pid),
      tools: this.registry.schemas(),
      projectDocs: [],
      userPromptFile: this.opts.resolved.paths.systemPromptFile,
    });
    this.session.provider = pid;
    this.session.model = modelId;
    if (persist) {
      const file = join(this.opts.resolved.paths.dataDir, 'config.json');
      try {
        const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
        existing.provider = pid;
        existing.models = { ...((existing.models as Record<string, unknown> | undefined) ?? {}), [pid]: modelId };
        writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
      } catch (e) {
        throw new Error(`Failed to persist provider/model to ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Set an API key: updates the live config and environment, rebuilds the provider when the
   * target is the active provider, and persists the key to the user-level config file
   * (~/.deepcode/config.json) so it survives restarts.
   */
  setApiKey(key: string, providerId?: ProviderId): void {
    const pid = providerId ?? this.config.provider;
    if (pid === 'ollama') throw new Error('Ollama does not require an API key');
    const ep = this.config.providers[pid];
    if (!ep) throw new Error(`Provider "${pid}" does not support an API key`);
    ep.apiKey = key;
    const envKey = API_KEY_ENV[pid];
    if (envKey) process.env[envKey] = key;
    if (pid === this.config.provider) {
      this.provider = createProvider(this.config, pid, this.provider.model);
    }
    const file = join(this.opts.resolved.paths.dataDir, 'config.json');
    try {
      const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
      const providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
      providers[pid] = { ...((providers[pid] as Record<string, unknown> | undefined) ?? {}), apiKey: key };
      existing.providers = providers;
      writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    } catch (e) {
      throw new Error(`API key set for this session, but failed to persist it to ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Verify an API key against the provider with a real, minimal request (no side effects).
   * Resolves on success; throws with the provider's error message on failure.
   */
  async testApiKey(key: string, providerId?: ProviderId): Promise<void> {
    const pid = providerId ?? this.config.provider;
    if (pid === 'ollama') return;
    const model = this.config.models[pid] ?? 'unknown-model';
    const ep = this.config.providers[pid];
    const probe = (): Promise<unknown> => {
      switch (pid) {
        case 'anthropic': {
          const client = new Anthropic({ apiKey: key, baseURL: ep?.baseUrl });
          return client.messages.create({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
        }
        case 'gemini': {
          const ai = new GoogleGenAI({ apiKey: key });
          return ai.models.generateContent({ model, contents: 'ping' });
        }
        case 'deepseek':
        case 'grok':
        case 'qwen':
        case 'openai-compat': {
          const baseUrl = ep?.baseUrl ?? (pid === 'deepseek' ? 'https://api.deepseek.com' : pid === 'grok' ? 'https://api.x.ai/v1' : pid === 'qwen' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : undefined);
          const client = new OpenAI({ apiKey: key, ...(baseUrl ? { baseURL: baseUrl } : {}) });
          return client.chat.completions.create({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
        }
        default:
          return Promise.resolve();
      }
    };
    await withTimeout(probe(), 20_000);
  }

  async runTurn(userInput: string): Promise<TurnResult> {
    this.turnInFlight = true;
    this.interruptRequested = false; // a fresh turn starts interrupt-clean (idle interrupt()s earlier are scoped away)
    const handler = this.approvalHandlerOverride ?? this.opts.approvalHandler ?? this.defaultApprovalHandler;
    try {
      return await runAgentTurn(
        {
          config: this.config,
          provider: this.provider,
          modelMeta: this.provider.modelMeta,
          registry: this.registry,
          executor: this.executor,
          gate: this.gate,
          usage: this.usage,
          session: this.session,
          sessionStore: this.sessionStore,
          todoStore: this.todoStore,
          emit: (e) => this.emit(e),
          systemPrompt: this.systemPrompt,
          approvalHandler: handler,
          extractFacts: this.memoryPipeline ? (turns) => this.memoryPipeline!.extractFromTurns(turns) : undefined,
          signal: this.abortController.signal,
          subagentRuntime: this.subagentRuntime,
        },
        userInput,
      );
    } finally {
      this.turnInFlight = false;
    }
  }

  /** Session end: auto-distills memories (L0->L2) and closes the memory database */
  async finalizeMemory(): Promise<void> {
    if (!this.memoryPipeline || !this.memoryDb) return;
    if (this.config.memory.autoExtract && this.session.messages.length >= 4) {
      const extracted = this.memoryPipeline.extractFromSession(this.session.messages);
      if (extracted.length > 0) {
        this.emit({ type: 'memory-saved', entries: extracted });
      }
    }
    this.memoryDb.close();
  }

  /** Manual compaction (/compact): returns the plan or null */
  async compactNow(): Promise<import('./agent/compressor.js').CompactionPlan | null> {
    const tokens = estimateMessagesTokens(this.session.messages);
    if (tokens < 1000) return null;
    const plan = compressMessages(this.session.messages, {
      targetRatio: 0.5,
      keepRecentTurns: this.config.context.keepRecentTurns,
      maxSummaryTokens: this.config.context.maxSummaryTokens,
      maxToolResultChars: 8000,
      extractFacts: this.opts.extractFacts,
    });
    if (plan.removedTurns > 0) {
      this.session.messages = plan.messages;
      this.sessionStore.appendCompaction(this.session.id, plan);
      this.emit({ type: 'compacted', plan });
      const window = this.provider.modelMeta.windowTokens || this.config.context.maxTokens;
      this.emit({ type: 'context', ratio: this.contextRatio(), window });
    }
    return plan.removedTurns > 0 ? plan : null;
  }

  /** In-session context usage (0-1) */
  contextRatio(): number {
    const window = this.provider.modelMeta.windowTokens || this.config.context.maxTokens;
    return estimateMessagesTokens(this.session.messages) / window;
  }

  private persistUsage(e: UsageEvent): void {
    try {
      this.usageStore.append(e);
      this.sessionStore.appendUsage(this.session.id, e);
    } catch {
      // usage persistence failures must not affect the main flow
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ type: 'session-end', sessionId: this.session.id, reason: 'exit' });
    this.usageStore.close();
    for (const cleanup of this.mcpCleanups) {
      void cleanup().catch(() => undefined);
    }
  }
}

export function providerLabel(id: ProviderId): string {
  switch (id) {
    case 'anthropic':
      return 'Anthropic';
    case 'deepseek':
      return 'DeepSeek';
    case 'grok':
      return 'Grok (xAI)';
    case 'gemini':
      return 'Gemini';
    case 'qwen':
      return 'Qwen (DashScope)';
    case 'ollama':
      return 'Ollama';
    case 'openai-compat':
      return 'OpenAI Compatible';
  }
}

/** Builtin extension directory shipped with the package (skills/plugins) */
function joinBuiltinDir(workspace: string, sub: string): string {
  return join(workspace, sub);
}

/** CLI approval (--print / no TUI): shows each item and reads y/n/a/d */
export async function cliApproval(items: ApprovalItem[]): Promise<ApprovalResult> {
  const decisions: ApprovalResult['decisions'] = [];
  for (const item of items) {
    const diff = item.diff ? `\n${item.diff.split('\n').slice(0, 80).join('\n')}\n` : '';
    process.stdout.write(`\n[approval] ${item.description}${item.command ? `\n$ ${item.command}` : ''}${diff}\n`);
    const answer = await readAnswer(`[y]allow [n]deny [a]always allow [d]always deny (default n): `);
    let action: 'allow' | 'deny' | 'allow-always' | 'deny-always' = 'deny';
    if (answer === 'y') action = 'allow';
    else if (answer === 'a') action = 'allow-always';
    else if (answer === 'd') action = 'deny-always';
    decisions.push({ callId: item.callId, action });
  }
  return { decisions, aborted: false };
}

function readAnswer(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const { stdin } = process;
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('\n') || buf.includes('\r')) {
        stdin.removeListener('data', onData);
        resolve(buf.trim().toLowerCase());
      }
    };
    stdin.on('data', onData);
    // fallback: non-interactive environments default to deny after 3 seconds
    setTimeout(() => {
      stdin.removeListener('data', onData);
      resolve('n');
    }, 3000);
  });
}

/** Reject a promise if it does not settle within the given milliseconds */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
