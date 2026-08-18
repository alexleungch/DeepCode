import type { DeepcodeConfig, ModelMeta, PriceEntry, ProviderId } from './types.js';

/** Built-in model capability table (defaults; users can override via config.modelMeta) */
export const BUILTIN_MODEL_META: Record<string, ModelMeta> = {
  // DeepSeek (official OpenAI-compatible endpoint; automatic prefix caching)
  'deepseek-chat': {
    id: 'deepseek-chat',
    windowTokens: 128_000,
    maxOutputTokens: 8_192, // documented max_tokens limit
    supportsVision: false,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'auto',
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    windowTokens: 128_000,
    maxOutputTokens: 8_192, // documented max_tokens limit
    supportsVision: false,
    supportsTools: true, // reasoner has no native function calling → simulated via the JSON tool calling protocol (toolCallProtocol: 'json')
    supportsThinking: true,
    cacheControl: 'auto',
    toolCallProtocol: 'json',
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    windowTokens: 1_000_000,
    maxOutputTokens: 393_216, // 384K output maximum (DeepSeek rejects any max_tokens > this with HTTP 400)
    supportsVision: false,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'auto',
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    windowTokens: 1_000_000,
    maxOutputTokens: 393_216, // 384K output maximum
    supportsVision: false,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'auto',
  },
  // Anthropic (explicit cache_control breakpoints; vision)
  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    maxOutputTokens: 64_000, // Anthropic per-request max_tokens limit
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'explicit',
  },
  'claude-opus-4-1': {
    id: 'claude-opus-4-1',
    windowTokens: 200_000,
    maxOutputTokens: 64_000, // Anthropic per-request max_tokens limit
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'explicit',
  },
  'claude-3-5-haiku': {
    id: 'claude-3-5-haiku',
    windowTokens: 200_000,
    maxOutputTokens: 8_192, // Anthropic per-request max_tokens limit for haiku
    supportsVision: true,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'explicit',
  },
  // Gemini (server-side automatic prefix caching; vision; large window)
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    windowTokens: 1_000_000,
    maxOutputTokens: 65_536, // Gemini output token cap
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'auto',
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    windowTokens: 1_000_000,
    maxOutputTokens: 65_536, // Gemini output token cap
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'auto',
  },
  // Grok (xAI; automatic/best-effort caching; vision)
  'grok-4': {
    id: 'grok-4',
    windowTokens: 256_000,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'none',
  },
  'grok-4-fast': {
    id: 'grok-4-fast',
    windowTokens: 256_000,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'none',
  },
  // Qwen (Alibaba Cloud DashScope / MaaS OpenAI-compatible endpoint; supports explicit cache_control breakpoints)
  'qwen3.8-max': {
    id: 'qwen3.8-max',
    windowTokens: 1_000_000,
    maxOutputTokens: 32_768, // thinking-mode output cap (normal mode caps at 65,536)
    supportsVision: false,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'explicit',
  },
  'qwen-plus': {
    id: 'qwen-plus',
    windowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'explicit',
  },
  'qwen3-coder-plus': {
    id: 'qwen3-coder-plus',
    windowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'explicit',
  },
  'qwen-vl-plus': {
    id: 'qwen-vl-plus',
    windowTokens: 128_000,
    maxOutputTokens: 32_768,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'explicit',
  },
  'qwen-flash': {
    id: 'qwen-flash',
    windowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'explicit',
  },
  // Ollama local models (override per model capability; KV reuse within a session)
  'qwen3:32b': {
    id: 'qwen3:32b',
    windowTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'auto',
  },
  'qwen2.5-coder:32b': {
    id: 'qwen2.5-coder:32b',
    windowTokens: 32_768,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'auto',
  },
  'llama3.1:70b': {
    id: 'llama3.1:70b',
    windowTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'auto',
  },
  'qwen2.5-vl:32b': {
    id: 'qwen2.5-vl:32b',
    windowTokens: 32_768,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'auto',
  },
};

/** Default model selection */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-4-5',
  deepseek: 'deepseek-chat',
  grok: 'grok-4',
  gemini: 'gemini-2.5-pro',
  qwen: 'qwen3.8-max',
  ollama: 'qwen3:32b',
  'openai-compat': 'custom-model',
};

/**
 * Official public prices (USD / 1M tokens). Values are based on the vendors' public 2025 price lists;
 * users can override them via config.pricing; entries not listed are treated as the same price as regular input.
 */
export const BUILTIN_PRICING: Record<string, PriceEntry> = {
  'deepseek-chat': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.028 },
  'deepseek-v4-pro': { input: 1.74, output: 3.48, cacheRead: 0.145 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
  'grok-4': { input: 3, output: 15 },
  'grok-4-fast': { input: 0.2, output: 0.5 },
  // Qwen cloud (DashScope) — approximate entry-tier rates (USD/1M tokens); overridable via config.pricing
  'qwen3.8-max': { input: 2, output: 6 },
  'qwen-plus': { input: 0.4, output: 1.2 },
  'qwen3-coder-plus': { input: 0.574, output: 2.294 },
  'qwen-vl-plus': { input: 0.4, output: 1.2 },
  'qwen-flash': { input: 0.05, output: 0.4 },
  'ollama-local': { input: 0, output: 0 },
};

export function defaultConfig(): DeepcodeConfig {
  return {
    provider: 'deepseek',
    models: { ...DEFAULT_MODELS },
    modelMeta: {},
    providers: {
      deepseek: { baseUrl: 'https://api.deepseek.com' },
      anthropic: {},
      grok: { baseUrl: 'https://api.x.ai/v1' },
      gemini: {},
      qwen: { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
      ollama: { baseUrl: 'http://localhost:11434' },
      'openai-compat': {},
    },
    permissions: {
      mode: 'ask',
      allow: [],
      deny: [],
      additionalDirectories: [],
    },
    context: {
      maxTokens: 128_000,
      // Compact earlier (76.8k vs 89.6k) so long sessions carry less full history per turn.
      compactAt: 0.6,
      autoCompact: true,
      keepRecentTurns: 5,
      maxSummaryTokens: 4000,
    },
    subagents: {
      enabled: true,
      maxConcurrent: 3,
      maxDepth: 2,
      worktree: 'auto',
    },
    memory: {
      enabled: true,
      autoExtract: true,
      injectTopK: 4,
    },
    agent: {
      maxTurns: 25,
      maxParallelTools: 4,
      toolTimeoutMs: 120_000,
    },
    pricing: {},
    mcpServers: {},
    skills: { enabled: true, directories: [] },
    plugins: { enabled: true, directories: [] },
    telegram: {
      allowChatIds: [],
      longPollTimeoutSec: 25,
      editIntervalMs: 1500,
      maxBubbleChars: 3500,
      permissionMode: 'acceptEdits',
    },
    ui: {
      theme: 'default',
    },
  };
}

/** Merge user config into defaults (shallow merge per section) */
export function mergeConfig(base: DeepcodeConfig, patch: Partial<DeepcodeConfig>): DeepcodeConfig {
  return {
    ...base,
    ...patch,
    models: { ...base.models, ...patch.models },
    modelMeta: { ...base.modelMeta, ...patch.modelMeta },
    providers: { ...base.providers, ...patch.providers },
    permissions: { ...base.permissions, ...patch.permissions },
    context: { ...base.context, ...patch.context },
    subagents: { ...base.subagents, ...patch.subagents },
    memory: { ...base.memory, ...patch.memory },
    agent: { ...base.agent, ...patch.agent },
    pricing: { ...base.pricing, ...patch.pricing },
    mcpServers: { ...base.mcpServers, ...patch.mcpServers },
    skills: { ...base.skills, ...patch.skills },
    plugins: { ...base.plugins, ...patch.plugins },
    telegram: { ...base.telegram, ...patch.telegram },
    ui: { ...base.ui, ...patch.ui },
  };
}

export function modelMetaFor(config: DeepcodeConfig, modelId: string): ModelMeta {
  const builtin = BUILTIN_MODEL_META[modelId];
  const override = config.modelMeta[modelId];
  return {
    ...(builtin ?? {
      id: modelId,
      windowTokens: config.context.maxTokens,
      supportsVision: false,
      supportsTools: true,
      supportsThinking: false,
      cacheControl: 'auto',
    }),
    ...override,
    id: modelId,
  };
}

export function pricingFor(config: DeepcodeConfig, modelId: string): PriceEntry {
  const builtin: PriceEntry = BUILTIN_PRICING[modelId] ?? { input: 0, output: 0 };
  const override = config.pricing[modelId] ?? {};
  return {
    input: override.input ?? builtin.input,
    output: override.output ?? builtin.output,
    cacheRead: override.cacheRead ?? builtin.cacheRead,
    cacheWrite: override.cacheWrite ?? builtin.cacheWrite,
  };
}
