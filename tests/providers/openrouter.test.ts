import { describe, it, expect } from 'vitest';
import { createProvider } from '../../src/providers/factory.js';
import { OpenAiCompatProvider } from '../../src/providers/openai-compat.js';
import { providerLabel } from '../../src/engine.js';
import { defaultConfig, DEFAULT_MODELS, BUILTIN_MODEL_META } from '../../src/config/defaults.js';
import { deepcodeConfigSchema, providerIds } from '../../src/config/types.js';

function configWithOpenRouter(apiKey: string) {
  const config = defaultConfig();
  config.provider = 'openrouter';
  config.providers.openrouter = { apiKey, baseUrl: 'https://openrouter.ai/api/v1' };
  return config;
}

describe('openrouter provider', () => {
  it('is registered as a provider id and has a default model', () => {
    expect(providerIds).toContain('openrouter');
    expect(DEFAULT_MODELS.openrouter).toBe('openrouter/auto');
  });

  it('defaults carry the OpenRouter endpoint', () => {
    const config = defaultConfig();
    expect(config.providers.openrouter?.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('factory builds an OpenAI-compatible provider pointed at openrouter.ai', () => {
    const provider = createProvider(configWithOpenRouter('sk-or-test'), 'openrouter', 'anthropic/claude-sonnet-4-5');
    expect(provider).toBeInstanceOf(OpenAiCompatProvider);
    expect(provider.id).toBe('openrouter');
    expect(provider.model).toBe('anthropic/claude-sonnet-4-5');
    // Builtin metadata for a known OpenRouter model id
    const meta = BUILTIN_MODEL_META['anthropic/claude-sonnet-4-5'];
    expect(meta?.windowTokens).toBe(200_000);
    expect(provider.modelMeta.windowTokens).toBe(200_000);
  });

  it('unknown OpenRouter model ids fall back to safe defaults (no throw)', () => {
    const provider = createProvider(configWithOpenRouter('sk-or-test'), 'openrouter', 'vendor/some-future-model');
    expect(provider.modelMeta.windowTokens).toBeGreaterThan(0);
    expect(provider.modelMeta.supportsTools).toBe(true);
  });

  it('providerLabel renders "OpenRouter"', () => {
    expect(providerLabel('openrouter')).toBe('OpenRouter');
  });

  it('config schema accepts the openrouter provider section', () => {
    const parsed = deepcodeConfigSchema.safeParse({
      provider: 'openrouter',
      providers: { openrouter: { apiKey: 'env:OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.providers?.openrouter?.apiKey).toBe('env:OPENROUTER_API_KEY');
    }
  });

  it('rejects unknown provider ids (schema guard stays tight)', () => {
    const parsed = deepcodeConfigSchema.safeParse({ provider: 'not-a-provider' });
    expect(parsed.success).toBe(false);
  });
});
