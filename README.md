# DeepCode

Claude Code-style TypeScript terminal coding agent CLI. ReAct agent loop + multi-provider + MCP + Skills + Plugins + Agent Memory + Prompt Caching + auto context compaction + browser rendering review.

```
❯ deepcode "Refactor the utils module and add tests"
   ⚙ glob **/*.ts        ✓
   ⚙ read_file utils.ts  ✓
   ⚙ edit_file           ✓ (diff approval)
   ⚙ run_terminal_cmd npm test ✓
   ⚙ browser_review      ✓ (screenshot + console errors)
[usage] in 45k / out 12k · cache↗ 30k · $0.02
```

## Features

| Capability | Description |
|---|---|
| **Multi-provider** | DeepSeek (default) / Anthropic / Gemini / Grok / local Ollama / any OpenAI-compatible endpoint |
| **ReAct agent loop** | Perception → action → observation closed loop; parallel tool calling; automatic self-correction on non-zero exit codes |
| **Ask approval mode (default)** | Writing files / running commands / deleting / committing / deploying pauses for human diff approval; batch approval; can attach revision feedback |
| **Native tools** | `read_file` `write_file` `edit_file` `run_terminal_cmd` `browser_review` `glob` `grep` `todo_write` `ask_user` `skill` `task` |
| **browser_review** | Automatically opens a browser to check UI rendering: screenshot + console/page errors + aria snapshot; vision models inspect the image directly |
| **MCP extensions** | Connect to any MCP server (Linear/Sentry/Postgres/Buddy…), stdio and HTTP/SSE |
| **Skills** | SKILL.md instruction packs (DSH-style): the system prompt injects a skill catalog, loading full text on demand |
| **Plugins** | Pure JS ESM plugins: tools + skills + mcpServers + hooks, all in one extension |
| **Agent Memory** | Four-layer memory pipeline (inspired by TencentDB-Agent-Memory): sessions auto-distill preferences/decisions/facts, FTS retrieval injection, fully local SQLite |
| **Prompt Caching** | Anthropic explicit `cache_control` breakpoints; DeepSeek/Gemini automatic prefix caching; prefix byte-stability discipline; live hit-rate and savings display |
| **Auto context compaction** | Automatically folds early turns into a summary when above threshold (tied to memory distillation); `/compact` manual trigger |
| **API Usage monitoring** | Usage Extractor collects in real time (body/header/streaming); SQLite + JSONL persistence; status bar cumulative tokens and cost; `/cost` dashboard |
| **Sub-agents + Worktree** | Spawn parallel independent sub-agents; clean git repos automatically get worktree isolation, merged after approval |
| **TUI / headless dual mode** | Ink TUI (streaming/history/slash commands/ESC interrupt) and `--print` script mode share the same engine |

## Quick Start

```bash
# 1. Build
pnpm install
pnpm build

# 2. Configure (choose any provider)
deepcode config init          # generates ~/.deepcode/config.json template
set DEEPSEEK_API_KEY=sk-xxx   # or edit the config file (env:VAR references supported)

# 3. Zero-cost start: local Ollama
deepcode --provider ollama --model qwen3:32b

# 4. Usage
deepcode "Explain this project's structure"           # TUI interactive (start working with a prompt)
deepcode -p "Fix the bug in src/main.ts"              # headless print mode (scripts/CI)
deepcode --continue                                   # resume the most recent session (memory auto-injected)
deepcode "Refactor" --permission-mode acceptEdits     # skip approval for file edits
```

### Provider configuration example

```jsonc
// ~/.deepcode/config.json
{
  "provider": "deepseek",
  "models": {
    "deepseek": "deepseek-chat",        // or deepseek-reasoner (JSON-protocol tool calling + reasoning passthrough)
    "anthropic": "claude-sonnet-4-5",
    "gemini": "gemini-2.5-pro",
    "grok": "grok-4",
    "ollama": "qwen3:32b"
  },
  "providers": {
    "deepseek": { "apiKey": "env:DEEPSEEK_API_KEY", "baseUrl": "https://api.deepseek.com" },
    "anthropic": { "apiKey": "env:ANTHROPIC_API_KEY" },
    "gemini": { "apiKey": "env:GOOGLE_API_KEY" },
    "grok": { "apiKey": "env:XAI_API_KEY", "baseUrl": "https://api.x.ai/v1" },
    "ollama": { "baseUrl": "http://localhost:11434" }
  },
  "permissions": { "mode": "ask", "allow": [], "deny": [], "additionalDirectories": [] },
  "context": { "maxTokens": 128000, "compactAt": 0.7, "autoCompact": true, "keepRecentTurns": 5 }
}
```

## TUI slash commands

| Command | Description |
|---|---|
| `/key [KEY]` | Set the API key for the current provider (verified against the API before saving; bare `/key` shows its status) |
| `/models` | List configured models (only vendors with a working API key) + supported vendors |
| `/models <vendor> [model]` | Add/switch a vendor: prompts for the model name and, if needed, the API key (verified against the API before saving; persisted to `~/.deepcode/config.json`) |
| `/cost` `/usage` | Usage dashboard: Input/Output/Cache Hits/Est. Cost + cache hit rate and savings |
| `/context` | Context window usage percentage + compaction threshold hints (anticipate when compaction will trigger) |
| `/compact` | Manual compaction (folds early turns, tied to memory distillation) |
| `/clear` `/exit` | Clear session / exit |
| `ESC` | Interrupt current generation and tool execution |

## Skills / Plugins / MCP

```bash
# Skills: place SKILL.md in any directory (YAML frontmatter: name/description + markdown body)
~/.deepcode/skills/<name>/SKILL.md      # user-level
<project>/.deepcode/skills/<name>/SKILL.md # project-level (overrides user-level)
deepcode skills list

# Plugins: pure JS ESM, exports { id, name, tools, skills, mcpServers, hooks }
~/.deepcode/plugins/<name>/plugin.js
deepcode plugins list

# MCP: after configuring a server, tools auto-register as mcp__<server>__<tool>
deepcode mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
deepcode mcp list
```

## Caching & Compaction (cost optimization)

- **DeepSeek**: automatic prefix caching (`prompt_cache_hit_tokens` reported in real time). Fixed system prompt section order, determinized tool schema key order, strictly append-only session messages → maximizes hit rate
- **Anthropic**: `cache_control` breakpoint planner (system + end-of-turn tool_result, ≤4 breakpoints)
- **Auto compaction**: folds early turns automatically when usage exceeds `compactAt` (default 70%); compacted content is distilled into memory first (zero information loss)
- Hit rate and estimated savings are visible in the status bar and the `/cost` dashboard

## Directory structure

```
src/
├── cli.ts                # entry (TUI / --print / subcommands)
├── config/               # layered config (default → user → project → env → CLI)
├── providers/            # Anthropic / DeepSeek / Grok / Gemini / Ollama adapters
├── agent/                # ReAct loop / system prompt / compressor / sub-agents
├── caching/              # breakpoint planning / cache metrics
├── tools/                # permission gate / registry / native tools / MCP / browser
├── skills/  plugins/     # SKILL.md loader / ESM plugin loader
├── memory/               # four-layer memory pipeline (SQLite + FTS5)
├── session/              # session persistence (atomic JSONL writes)
├── usage/                # Usage Extractor / pricing / persistence
├── ui/                   # Ink TUI (state reduction / markdown / components)
└── git/                  # repo detection / worktree isolation
```

## Testing

```bash
pnpm test        # 88 tests: config/permissions/compaction/caching/usage/memory/worktree/MCP/loop/rendering
pnpm typecheck
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Provider integration](docs/PROVIDERS.md)
- [Caching & compaction](docs/CACHING.md)
- [Skills / Plugins / MCP](docs/EXTENSIONS.md)
- [Agent Memory](docs/MEMORY.md)
- [Browser rendering review](docs/BROWSER_REVIEW.md)
