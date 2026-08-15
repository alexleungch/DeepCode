# Architecture Overview

## Layered Design

```
┌─────────────────────────────────────────────────────────┐
│ Render layer (swappable)                                │
│  Ink TUI (src/ui)       --print headless (src/ui/print) │
└──────────────────────┬──────────────────────────────────┘
                       │ typed event stream (src/events.ts)
┌──────────────────────▼──────────────────────────────────┐
│ Engine layer DeepcodeEngine (src/engine.ts)             │
│  ├─ Agent loop (agent/loop.ts): ReAct + parallel tools  │
│  ├─ Permission gate (tools/permission.ts): Ask default  │
│  ├─ Usage (usage/): Extractor → tracker → SQLite/JSONL  │
│  ├─ Caching (caching/): breakpoints + hit-rate metrics  │
│  ├─ Compaction (agent/compressor.ts) → memory link      │
│  └─ Sub-agents (agent/subagent.ts) + worktree (git/)    │
└───────┬──────────────────────┬──────────────────────────┘
        │                      │
┌───────▼──────────┐  ┌────────▼──────────────────────────┐
│ Provider adapters│  │ Tool registry (tools/registry.ts) │
│ anthropic.ts     │  │ native tools / browser_review     │
│ openai-compat.ts │  │ skill / task / memory_*           │
│ gemini.ts        │  │ MCP bridge (tools/mcp/)           │
│ ollama.ts        │  │ plugin tools (plugins/)           │
└──────────────────┘  └───────────────────────────────────┘
```

## Core Design Decisions

### 1. Engine/UI separation
The engine has zero UI dependencies and only emits typed `EngineEvent` events; the Ink TUI and the `--print` renderer consume the same engine.
The event reduction in `src/ui/state.ts` is a pure function and can be unit-tested (tests/tui.test.ts).

### 2. Unified Provider abstraction
All adapters normalize to `LLMRequest/LLMResponse/LLMStreamEvent/Usage`:
- **Anthropic**: native tools + `cache_control` breakpoints + extended thinking
- **OpenAI-compatible** (DeepSeek/Grok/any endpoint): `stream_options.include_usage` + passthrough of `prompt_cache_hit_tokens`, `reasoning_content`
- **Gemini**: functionDeclarations + usageMetadata (including cachedContentTokenCount)
- **Ollama**: local `/api/chat`, `keep_alive` resident; automatic downgrade retry when tools are unsupported

### 3. Agent loop
```
perception (project docs / memory retrieval / skill catalog / todos)
  → prefix stability check (compact first if above threshold)
  → LLM streaming request (real-time Usage collection, breakpoint placement)
  → parallel execution of multiple tool_use (batch approval → gate → executor)
  → Observations refilled in order → loop (cap: maxTurns / ESC interrupt)
```

### 4. Permission gate
- Modes: `ask` (default) | `acceptEdits` | `plan` | `bypassPermissions`
- Dangerous-command blacklist is hard-rejected (including in bypass mode): `rm -rf /`, `git push --force`, fork bombs, etc.
- Path normalization + out-of-workspace access denied by default; `additionalDirectories` whitelist
- Write operations run `preview()` to generate a diff before approval (the core Ask-mode experience)

### 5. Data flow
- Event flow: engine → TUI state (reduction) → Ink rendering
- Usage flow: Provider usage → UsageTracker (instant pricing) → SQLite + JSONL + status bar
- Memory flow: compaction/session end → rule distillation → MemoryDb (SQLite+FTS5) → digest injection in the next session
