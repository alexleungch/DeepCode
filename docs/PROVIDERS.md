# Provider Integration Guide

## Capability Overview

| Provider | Endpoint | Tool calling | Caching | Vision | Thinking mode |
|---|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | ✅ (deepseek-chat) | Automatic prefix caching | ❌ | `deepseek-reasoner` (no tools) |
| Anthropic | SDK default | ✅ | Explicit `cache_control` | ✅ | ✅ |
| Gemini | `@google/genai` | ✅ | Automatic prefix caching | ✅ | ✅ |
| Grok (xAI) | `https://api.x.ai/v1` | ✅ | Server-side automatic (best effort) | ✅ | ✅ |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | ✅ | Automatic context caching | `qwen-vl-*` ✅ | `qwen3.8-max` ✅ |
| Ollama | `http://localhost:11434` | Per model (automatic downgrade) | In-session KV reuse | Vision models ✅ | — |
| OpenRouter | `https://openrouter.ai/api/v1` | ✅ (per routed model) | Automatic (best effort) | Per model config | `deepseek/deepseek-r1` ✅ (JSON protocol) |
| openai-compat | Any | ✅ | Best effort | Per model config | — |

## API Keys

```bash
set DEEPSEEK_API_KEY=sk-...      # DeepSeek
set ANTHROPIC_API_KEY=sk-ant-... # Anthropic
set GOOGLE_API_KEY=...           # Gemini
set XAI_API_KEY=...              # Grok
set DASHSCOPE_API_KEY=sk-...     # Qwen (Alibaba Cloud Model Studio / DashScope)
set OPENROUTER_API_KEY=sk-or-... # OpenRouter (any model, vendor-prefixed ids)
set DEEPCODE_API_KEY=...         # generic compatible endpoint
```

The config file can reference environment variables with `"apiKey": "env:DEEPSEEK_API_KEY"` to avoid plaintext keys.

## OpenRouter

OpenRouter is a gateway over many model vendors and speaks the OpenAI-compatible API, so it reuses
the `openai-compat` adapter:

```bash
set OPENROUTER_API_KEY=sk-or-...
deepcode --provider openrouter --model anthropic/claude-sonnet-4-5
# or in the TUI:  /models openrouter anthropic/claude-sonnet-4-5
```

- Model ids are vendor-prefixed (`anthropic/…`, `deepseek/…`, `qwen/…`, `meta-llama/…`, …); `openrouter/auto` routes automatically.
- Built-in capability metadata covers common ids (`anthropic/claude-sonnet-4-5`, `deepseek/deepseek-chat-v3-0324`, `deepseek/deepseek-r1`, `qwen/qwen3-coder-plus`, `meta-llama/llama-3.3-70b-instruct`); any other id falls back to safe defaults and can be tuned via `config.modelMeta`.
- Thinking tokens surface via the `reasoning` field (DeepSeek-style `reasoning_content` is also forwarded).
- Caching is best effort; set `cacheControl` per model in `config.modelMeta` to opt out.

## Model capability metadata

`config.modelMeta` can override the built-in model table (`src/config/defaults.ts`):

```jsonc
{
  "modelMeta": {
    "deepseek-chat": { "windowTokens": 131072, "supportsVision": false }
  },
  "pricing": {
    "deepseek-chat": { "input": 0.27, "output": 1.1, "cacheRead": 0.07 }
  }
}
```

## Known limitations

- **deepseek-reasoner tool calling (JSON protocol)**: the reasoner does not support native function calling ([official confirmation](https://github.com/deepseek-ai/DeepSeek-R1/issues/836)); deepcode implements it via a **JSON output contract simulation** ([tool calling polyfill](https://github.com/zed-industries/zed/discussions/43380)):
  - The system prompt injects the tool catalog and output contract (`{"tool_calls": [...]}` / `{"response": "..."}`)
  - Model output is parsed into tool calls → goes through the full ReAct loop; tool results are refilled as `[tool result <name>]` text
  - Non-JSON output automatically degrades to plain text (no interruption)
  - Can be enabled for any compatible model via `config.modelMeta.<model>.toolCallProtocol: "json"`
- Ollama tool support depends on the model (llama3.1/qwen3 support it); when the API reports a tools error, it automatically retries in no-tools mode
- Custom OpenAI-compatible endpoints must include the correct API prefix in the baseUrl (e.g. `/v1`)
