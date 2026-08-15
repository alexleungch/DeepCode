import type { DeepcodeConfig, ProviderId } from '../config/types.js';
import type { LLMProvider } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatProvider } from './openai-compat.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';

export function createProvider(config: DeepcodeConfig, providerId: ProviderId, model: string): LLMProvider {
  switch (providerId) {
    case 'anthropic':
      return new AnthropicProvider(config, model);
    case 'deepseek':
      return new OpenAiCompatProvider(config, model, {
        id: 'deepseek',
        label: 'DeepSeek',
        defaultBaseUrl: 'https://api.deepseek.com',
        envKey: 'DEEPSEEK_API_KEY',
      });
    case 'grok':
      return new OpenAiCompatProvider(config, model, {
        id: 'grok',
        label: 'Grok (xAI)',
        defaultBaseUrl: 'https://api.x.ai/v1',
        envKey: 'XAI_API_KEY',
      });
    case 'gemini':
      return new GeminiProvider(config, model);
    case 'ollama':
      return new OllamaProvider(config, model);
    case 'openai-compat': {
      const name = config.providers['openai-compat']?.name ?? 'OpenAI Compatible';
      return new OpenAiCompatProvider(config, model, {
        id: 'openai-compat',
        label: name,
        defaultBaseUrl: config.providers['openai-compat']?.baseUrl ?? '',
        envKey: 'DEEPCODE_API_KEY',
      });
    }
  }
}
