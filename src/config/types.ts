import { z } from 'zod';

export const providerIds = [
  'anthropic',
  'deepseek',
  'grok',
  'gemini',
  'qwen',
  'ollama',
  'openrouter',
  'openai-compat',
] as const;

export type ProviderId = (typeof providerIds)[number];

export const permissionModes = ['ask', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type PermissionMode = (typeof permissionModes)[number];

export const worktreeModes = ['auto', 'on', 'off'] as const;
type WorktreeMode = (typeof worktreeModes)[number];

export const memoryTypes = ['fact', 'preference', 'experience', 'episode'] as const;
export type MemoryType = (typeof memoryTypes)[number];

/** Per-model capability metadata (drives caching strategy, vision injection, tool use) */
export interface ModelMeta {
  id: string;
  /** Context window (tokens) */
  windowTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsThinking?: boolean;
  /** Caching ability: explicit=explicit breakpoints (Anthropic); auto=server-side automatic prefix caching; none=best effort */
  cacheControl: 'explicit' | 'auto' | 'none';
  /**
   * Tool-calling protocol: native=native function calling;
   * json=JSON protocol emulation (e.g. deepseek-reasoner lacks native tool_use; parsed via an output contract)
   */
  toolCallProtocol?: 'native' | 'json';
  /**
   * Max output tokens per request (defaults to the model's context window, clamped to 32768, in
   * agent/loop.ts — never an unbounded value: APIs reject max_tokens above the model's output
   * limit, e.g. DeepSeek returns HTTP 400 for anything > 393216).
   */
  maxOutputTokens?: number;
}

/** Price table: USD / 1M tokens */
export interface PriceEntry {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface McpServerConfig {
  /** stdio server */
  command?: string;
  args?: string[];
  /** HTTP/SSE server */
  url?: string;
  env?: Record<string, string>;
  /** Tool prefix registered per server name; defaults to mcp__<server>__ */
  toolPrefix?: string;
  /** Whether to show approval dialogs (default true) */
  askApproval?: boolean;
}

export interface SkillConfig {
  enabled: boolean;
  /** Extra skill directories (appended to the default scan paths) */
  directories: string[];
}

export interface PluginConfig {
  enabled: boolean;
  /** Extra plugin directories */
  directories: string[];
}

export interface TelegramConfig {
  /** Bot token (plain string or env:VAR). Default: read TELEGRAM_BOT_TOKEN */
  botToken?: string;
  /** Allowlist of chat IDs. Empty = deny all (must be explicitly configured). */
  allowChatIds?: number[];
  /** getUpdates long-poll timeout (seconds), default 25 */
  longPollTimeoutSec?: number;
  /** editMessageText throttle interval (ms), default 1500 */
  editIntervalMs?: number;
  /** Editable bubble length cap while streaming, default 3500 */
  maxBubbleChars?: number;
  /** Permission mode for the bot session, default 'acceptEdits' */
  permissionMode?: PermissionMode;
  /** Engine workspace override, default = cwd */
  workspace?: string;
}

/** TUI appearance settings (see src/ui/themes.ts for the built-in registry) */
export interface UiConfig {
  /** TUI theme id (default, dracula, gruvbox, nord, solarized, matrix, light, gruvbox-light).
   *  When unset, the TUI auto-detects the terminal background and uses a light theme
   *  on light terminals (see src/ui/background.ts). */
  theme?: string;
}

/** Prompt engineering knobs (see docs/PROMPT_SYSTEM.md). All prompt text stays cache-prefix stable. */
export interface PromptConfig {
  /** Compactness directive in the output contract (dimension 1: token optimization) */
  outputStyle: 'concise' | 'balanced' | 'detailed';
  /** Soft cap on each assistant text reply in characters; 0 = disabled */
  maxResponseChars: number;
  /** Few-shot example bank injected into the output contract (dimension 3; max 5, keep short) */
  examples: string[];
  /** Explicit completion protocol section: when to end a turn, never ask redundant confirmations (dimension 2) */
  completionProtocol: boolean;
  /** Verify-on-done contract: run checks and quote real output before declaring completion (dimension 4) */
  verifyOnDone: boolean;
  /** Eval quality gate thresholds (dimension 5: harness) */
  quality: {
    /** Minimum tool success rate (tool-result.isError ratio) */
    minToolSuccessRate: number;
    /** Maximum turns per eval task */
    maxTurns: number;
    /** Maximum total tokens per eval task (input+output) */
    maxTokensPerTask: number;
    /** Require the replayed UI state to be fully settled (spinner-stuck invariant) */
    requireSettled: boolean;
    /** Self-feedback retry budget: how many times a failing task may re-run with a feedback hint */
    maxRetriesOnFail: number;
  };
}

export interface AgentConfig {
  /** Max agent loop turns per conversation */
  maxTurns: number;
  /** Hard safety cap on TOTAL turns across compactions within a single runTurn call.
   *  Compaction resets the per-segment counter (maxTurns), but a runaway tool loop must
   *  eventually stop; this is that backstop. */
  maxTotalTurns: number;
  /** Max concurrency for parallel tool_use execution */
  maxParallelTools: number;
  /** Per-tool timeout for bash/browser etc. (ms) */
  toolTimeoutMs: number;
}

export interface ContextConfig {
  /** Context window cap (tokens); defaults to the model; an explicit config overrides it */
  maxTokens: number;
  /** Compaction trigger threshold (usage ratio 0-1) */
  compactAt: number;
  /** Force a compaction every N turns (0 = disabled). This resets the per-segment turn counter,
   *  so a long agentic task is not capped by agent.maxTurns just because it takes many tool steps. */
  compactEveryTurns: number;
  autoCompact: boolean;
  /** Most recent N turns kept verbatim when compacting */
  keepRecentTurns: number;
  /** Summary token cap */
  maxSummaryTokens: number;
}

export interface SubagentConfig {
  enabled: boolean;
  maxConcurrent: number;
  maxDepth: number;
  worktree: WorktreeMode;
  /** Independent turn budget for each sub-agent (does NOT consume the main agent's counter).
   *  A sub-agent that needs many tool steps (tracing, grep loops, builds) can run this many turns
   *  before it must wrap up with a report. */
  maxTurns: number;
}

export interface MemoryConfig {
  enabled: boolean;
  /** Auto-extract on session end / compaction */
  autoExtract: boolean;
  /** Number of memories injected into the system prompt */
  injectTopK: number;
  /** Memory database file path (default ~/.deepcode/memory.db) */
  dbPath?: string;
}

export interface PermissionConfig {
  mode: PermissionMode;
  /** Like "ToolName" or "ToolName:pattern" (bash uses a command regex) */
  allow: string[];
  deny: string[];
  /** Additional read/write directories outside the workspace */
  additionalDirectories: string[];
}

export interface ProviderEndpointConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface DeepcodeConfig {
  provider: ProviderId;
  /** Default model per provider */
  models: Partial<Record<ProviderId, string>>;
  /** Model capability overrides: modelId -> ModelMeta (built-in table by default) */
  modelMeta: Record<string, Partial<ModelMeta>>;
  providers: {
    anthropic?: ProviderEndpointConfig;
    deepseek?: ProviderEndpointConfig;
    grok?: ProviderEndpointConfig;
    gemini?: ProviderEndpointConfig;
    qwen?: ProviderEndpointConfig;
    ollama?: { baseUrl?: string; keepAlive?: string };
    /** OpenRouter gateway (OpenAI-compatible API at https://openrouter.ai/api/v1) */
    openrouter?: ProviderEndpointConfig;
    'openai-compat'?: ProviderEndpointConfig & { name?: string };
  };
  permissions: PermissionConfig;
  context: ContextConfig;
  subagents: SubagentConfig;
  memory: MemoryConfig;
  agent: AgentConfig;
  pricing: Record<string, Partial<PriceEntry>>;
  mcpServers: Record<string, McpServerConfig>;
  skills: SkillConfig;
  plugins: PluginConfig;
  prompt: PromptConfig;
  telegram?: TelegramConfig;
  ui?: UiConfig;
}

export const providerEndpointSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const mcpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    toolPrefix: z.string().optional(),
    askApproval: z.boolean().optional(),
  })
  .refine((s) => !!s.command || !!s.url, {
    message: 'MCP server must provide a command or url',
  });

/**
 * Config zod schema: every field is optional (the config file is an override layer over the defaults).
 * The parsed result is merged with the defaults to produce the full DeepcodeConfig.
 */
export const deepcodeConfigSchema = z
  .object({
    provider: z.enum(providerIds),
    models: z.record(z.string(), z.string()),
    modelMeta: z.record(z.string(), z.any()),
    providers: z.object({
      anthropic: providerEndpointSchema.optional(),
      deepseek: providerEndpointSchema.optional(),
      grok: providerEndpointSchema.optional(),
      gemini: providerEndpointSchema.optional(),
      qwen: providerEndpointSchema.optional(),
      ollama: z.object({ baseUrl: z.string().optional(), keepAlive: z.string().optional() }).optional(),
      openrouter: providerEndpointSchema.optional(),
      'openai-compat': providerEndpointSchema.extend({ name: z.string().optional() }).optional(),
    }),
    permissions: z.object({
      mode: z.enum(permissionModes),
      allow: z.array(z.string()),
      deny: z.array(z.string()),
      additionalDirectories: z.array(z.string()),
    }),
    context: z.object({
      maxTokens: z.number().int().positive(),
      compactAt: z.number().min(0.1).max(0.99),
      compactEveryTurns: z.number().int().min(0).max(200),
      autoCompact: z.boolean(),
      keepRecentTurns: z.number().int().min(1).max(20),
      maxSummaryTokens: z.number().int().positive(),
    }),
    subagents: z.object({
      enabled: z.boolean(),
      maxConcurrent: z.number().int().min(1).max(16),
      maxDepth: z.number().int().min(0).max(8),
      worktree: z.enum(worktreeModes),
      maxTurns: z.number().int().min(1).max(200),
    }),
    memory: z.object({
      enabled: z.boolean(),
      autoExtract: z.boolean(),
      injectTopK: z.number().int().min(0).max(20),
      dbPath: z.string().optional(),
    }),
    agent: z.object({
      maxTurns: z.number().int().min(1).max(200),
      maxTotalTurns: z.number().int().min(1).max(2000),
      maxParallelTools: z.number().int().min(1).max(16),
      toolTimeoutMs: z.number().int().positive(),
    }),
    pricing: z.record(z.string(), z.record(z.string(), z.number())),
    mcpServers: z.record(z.string(), mcpServerSchema),
    skills: z.object({
      enabled: z.boolean(),
      directories: z.array(z.string()),
    }),
    plugins: z.object({
      enabled: z.boolean(),
      directories: z.array(z.string()),
    }),
    prompt: z.object({
      outputStyle: z.enum(['concise', 'balanced', 'detailed']),
      maxResponseChars: z.number().int().min(0).max(100_000),
      examples: z.array(z.string().max(2000)).max(5),
      completionProtocol: z.boolean(),
      verifyOnDone: z.boolean(),
      quality: z.object({
        minToolSuccessRate: z.number().min(0).max(1),
        maxTurns: z.number().int().min(1).max(2000),
        maxTokensPerTask: z.number().int().positive(),
        requireSettled: z.boolean(),
        maxRetriesOnFail: z.number().int().min(0).max(10),
      }),
    }),
    telegram: z
      .object({
        botToken: z.string().optional(),
        allowChatIds: z.array(z.number().int().nonnegative()).optional(),
        longPollTimeoutSec: z.number().int().min(1).max(50).optional(),
        editIntervalMs: z.number().int().min(200).max(10000).optional(),
        maxBubbleChars: z.number().int().min(500).max(4000).optional(),
        permissionMode: z.enum(permissionModes).optional(),
        workspace: z.string().optional(),
      })
      .optional(),
    ui: z
      .object({
        theme: z.string().optional(),
      })
      .optional(),
  })
  .partial();
