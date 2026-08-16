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

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage Examples](#usage-examples)
- [TUI Slash Commands](#tui-slash-commands)
- [Skills / Plugins / MCP](#skills--plugins--mcp)
- [Caching & Compaction (cost optimization)](#caching--compaction-cost-optimization)
- [Directory Structure](#directory-structure)
- [Testing](#testing)
- [Contributing](#contributing)
- [Documentation](#documentation)
- [License](#license)

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

## Installation

### Prerequisites

- **Node.js ≥ 20** (ESM-only runtime; `node:sqlite` is used for memory persistence)
- **pnpm** (recommended package manager — the repo ships a `pnpm-lock.yaml`; `npm`/`yarn` work as well)

```bash
node --version   # >= 20
pnpm --version
```

### Option A — Global install from the npm registry

```bash
pnpm add -g deepcode
# or
npm install -g deepcode
```

This exposes the `deepcode` binary on your `PATH`.

### Option B — From source (recommended for development)

```bash
git clone <your-repo-url> deepcode
cd deepcode
pnpm install
pnpm build          # bundles src/ → dist/ (tsup)
```

Then make the CLI available globally (optional):

```bash
pnpm link --global
```

Or run it without installing:

```bash
pnpm start          # node dist/cli.js
pnpm dev            # tsx src/cli.ts (watch-free, no build needed)
```

### Verify the installation

```bash
deepcode --version          # 0.1.0
deepcode doctor             # health check: config, provider keys, permissions, git
```

If you run the CLI before building, the startup shim prints a hint:

```
[deepcode] startup failed (dist not built? run pnpm build first)
```

## Quick Start

```bash
# 1. Generate a config file
deepcode config init          # creates ~/.deepcode/config.json template

# 2. Provide an API key (choose any provider)
set DEEPSEEK_API_KEY=sk-xxx   # or edit the config file (env:VAR references supported)

# 3. Zero-cost start: local Ollama
deepcode --provider ollama --model qwen3:32b

# 4. Go
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

> **Tip:** use `"apiKey": "env:VAR_NAME"` to reference environment variables instead of storing plaintext keys.

## Usage Examples

### 1. Interactive TUI

```bash
deepcode                              # start an empty session
deepcode "Draft a README for src/"    # start a session with an initial prompt
```

In the TUI you get streaming output, history, slash commands and `ESC` to interrupt the current generation or tool execution.

### 2. Headless / script mode

`--print` (`-p`) runs the same engine with plain-text output — ideal for scripts and CI:

```bash
deepcode -p "Add JSDoc to every exported function in src/utils.ts"
deepcode -p "Summarize git diff HEAD~3" --permission-mode plan
```

### 3. Session management

```bash
deepcode --continue                  # resume the most recent session (memory auto-injected)
deepcode --resume <session-id>       # resume a specific session
deepcode sessions list               # list all sessions
deepcode sessions show <session-id>  # inspect a session transcript
deepcode sessions rm <session-id>    # delete a session
```

### 4. Permission modes

```bash
deepcode "Fix all failing tests"                                  # ask (default): approve each write/command
deepcode "Refactor" --permission-mode acceptEdits                 # auto-accept file edits, still ask for commands
deepcode "Plan an approach" --permission-mode plan                # read-only planning, no mutations
deepcode "Deploy" --permission-mode bypassPermissions             # no approval prompts (CI, trusted tasks)
```

### 5. Switching providers and models

```bash
deepcode --provider anthropic --model claude-sonnet-4-5
deepcode --provider ollama --model qwen3:32b
deepcode --provider deepseek --model deepseek-reasoner
```

Or at runtime inside the TUI: `/models deepseek deepseek-reasoner` (prompts for the model and, if needed, the API key).

### 6. Configuration

```bash
deepcode config init                  # generate the template config
deepcode config show                  # print the merged config (defaults → user → project → env → CLI)
deepcode config set provider deepseek # set a single key
```

### 7. Usage, memory and diagnostics

```bash
deepcode usage report                 # per-session token/cost report
deepcode memory status                # memory layer status
deepcode memory list --limit 20       # recent memory entries (--type fact|preference|experience|episode)
deepcode memory search "user prefers" # FTS retrieval
deepcode doctor                       # environment health check
```

### 8. Skills / Plugins / MCP management

```bash
deepcode skills list                  # installed SKILL.md packs
deepcode plugins list                 # installed ESM plugins
deepcode mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
deepcode mcp list                     # configured MCP servers
deepcode mcp remove <server>          # remove a server
```

### 9. Scripting a workflow (CI example)

```bash
#!/usr/bin/env bash
set -euo pipefail
for target in src/utils.ts src/api.ts; do
  deepcode -p "Review $target for bugs, performance and edge cases" --permission-mode plan
done
```

### 10. Programmatic API (TypeScript)

DeepCode exposes its engine as a library (`dist/index.d.ts` ships with the package) for secondary development and plugin consumption:

```ts
import { loadConfig, DeepcodeEngine } from 'deepcode';

const resolved = loadConfig({ provider: 'deepseek', model: 'deepseek-chat' });
const engine = new DeepcodeEngine({ resolved });

// Subscribe to engine events
engine.onEvent((event) => {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(event.text);
      break;
    case 'tool-start':
      console.error(`\n⚙ ${event.name} ${JSON.stringify(event.input)}`);
      break;
    case 'usage':
      console.error(`\n[usage] ${event.usage.inputTokens ?? 0} in / ${event.usage.outputTokens ?? 0} out`);
      break;
  }
});

await engine.init();
const result = await engine.runTurn('Explain this project structure');
console.error(`\n[stop] ${result.stopReason}`);
await engine.finalizeMemory();
engine.close();
```

Other public exports include `ToolRegistry`, `ToolExecutor`, `PermissionGate`, `runAgentTurn`, `UsageTracker`, `SessionStore`, `SkillLoader`, `PluginLoader` and the config utilities (`loadConfig`, `mergeConfig`, `pricingFor`, …) — see `src/index.ts`.

## TUI Slash Commands

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

See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for the full plugin shape (`tools`, `skills`, `mcpServers`, `hooks`) and MCP configuration reference.

## Caching & Compaction (cost optimization)

- **DeepSeek**: automatic prefix caching (`prompt_cache_hit_tokens` reported in real time). Fixed system prompt section order, determinized tool schema key order, strictly append-only session messages → maximizes hit rate
- **Anthropic**: `cache_control` breakpoint planner (system + end-of-turn tool_result, ≤4 breakpoints)
- **Auto compaction**: folds early turns automatically when usage exceeds `compactAt` (default 70%); compacted content is distilled into memory first (zero information loss)
- Hit rate and estimated savings are visible in the status bar and the `/cost` dashboard

## Directory Structure

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
pnpm test:watch  # watch mode
pnpm typecheck   # tsc --noEmit (strict)
```

## Contributing

Contributions of all kinds are welcome — bug reports, feature ideas, docs, and code.

### Development setup

```bash
git clone <your-repo-url> deepcode
cd deepcode
pnpm install
pnpm dev          # run the CLI from source without building
pnpm test         # run the test suite
```

### Commands

| Command | Description |
|---|---|
| `pnpm dev` | Run the CLI from source via `tsx` (no build step) |
| `pnpm build` | Bundle `src/` → `dist/` with tsup (ESM, Node 20 target) |
| `pnpm start` | Run the built CLI (`node dist/cli.js`) |
| `pnpm test` | Run all Vitest tests (`tests/**/*.test.{ts,tsx}`, 30 s timeout) |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm typecheck` | `tsc --noEmit` with strict settings |
| `pnpm doctor` | Run the CLI's `doctor` health check |

### Code conventions

- **TypeScript strict**: the project compiles with `strict`, `noUncheckedIndexedAccess` and `noImplicitOverride` enabled — your code must typecheck cleanly (`pnpm typecheck`).
- **ESM only**: `"type": "module"` with `NodeNext` module resolution; use `import`/`export` with explicit `.js` extensions for relative paths (e.g. `import { loadConfig } from './config/loader.js'`).
- **React for TUI components**: UI code under `src/ui/` uses React + Ink (`jsx: react-jsx`).
- **Keep behavior covered**: new tools, permission paths, memory/compaction logic and provider adapters should ship with Vitest tests under `tests/`. Look at the existing fixtures (`tests/fixtures`) for helper patterns.

### Pull request workflow

1. **Fork & branch** — create a feature branch from `main` (e.g. `feat/xxx`, `fix/xxx`).
2. **Implement** — follow the conventions above; keep changes focused and reviewable.
3. **Test** — run `pnpm test` and `pnpm typecheck`; both must pass locally.
4. **Document** — if behavior changes (config keys, CLI flags, tool schemas, provider behavior), update the relevant section of this README or `docs/*.md`.
5. **Open the PR** — describe *what* changed, *why*, and how it was tested. Reference related issues.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`. Examples:

```
feat(providers): add OpenAI-compatible endpoint support
fix(memory): persist distilled facts before process exit
docs: add installation and contribution guide
```

### Reporting issues

When opening an issue, include: the environment (`node --version`, `deepcode --version`), the provider/model in use, the exact command that failed, and any relevant log output (run with `-v` for verbose output).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Provider integration](docs/PROVIDERS.md)
- [Caching & compaction](docs/CACHING.md)
- [Skills / Plugins / MCP](docs/EXTENSIONS.md)
- [Agent Memory](docs/MEMORY.md)
- [Browser rendering review](docs/BROWSER_REVIEW.md)

## License

This project does not currently include a LICENSE file. Please contact the maintainers before reusing or redistributing the code.
