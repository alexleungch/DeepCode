import type { DeepcodeConfig, ModelMeta, PriceEntry, ProviderId } from './types.js';

/** Built-in model capability table (defaults; users can override via config.modelMeta) */
export const BUILTIN_MODEL_META: Record<string, ModelMeta> = {
  // DeepSeek (official OpenAI-compatible endpoint; automatic prefix caching)
  'deepseek-chat': {
    id: 'deepseek-chat',
    windowTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'auto',
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    windowTokens: 128_000,
    supportsVision: false,
    supportsTools: true, // reasoner has no native function calling → simulated via the JSON tool calling protocol (toolCallProtocol: 'json')
    supportsThinking: true,
    cacheControl: 'auto',
    toolCallProtocol: 'json',
  },
  // Anthropic (explicit cache_control breakpoints; vision)
  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'explicit',
  },
  'claude-opus-4-1': {
    id: 'claude-opus-4-1',
    windowTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'explicit',
  },
  'claude-3-5-haiku': {
    id: 'claude-3-5-haiku',
    windowTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: false,
    cacheControl: 'explicit',
  },
  // Gemini (server-side automatic prefix caching; vision; large window)
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    windowTokens: 1_000_000,
    supportsVision: true,
    supportsTools: true,
    supportsThinking: true,
    cacheControl: 'auto',
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    windowTokens: 1_000_000,
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
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
  'grok-4': { input: 3, output: 15 },
  'grok-4-fast': { input: 0.2, output: 0.5 },
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
      compactAt: 0.7,
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
