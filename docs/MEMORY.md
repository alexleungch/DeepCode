# Agent Memory (inspired by TencentCloud/TencentDB-Agent-Memory)

## Four-layer progressive pipeline

| Layer | Content | Carrier |
|---|---|---|
| **L0 Session stream** | Current session messages | `~/.deepcode/sessions/*.jsonl` |
| **L1 Working memory** | Key facts/decisions auto-distilled within the session | MemoryDb (distilled at compaction / during session) |
| **L2 Long-term memory** | Cross-session persistence: user preferences / project conventions / lessons learned | MemoryDb (SQLite + FTS5) |
| **L3 Project knowledge** | Project docs (CLAUDE.md/AGENTS.md/DEEPCODE.md) + project-level memory + skills/plugins metadata | Filesystem + MemoryDb (project scope) |

## Storage (fully local, zero external API dependencies)

- `~/.deepcode/memory.db`: `memories` table (scope/type/content/summary/importance/access_count…) + FTS5 virtual table + sync triggers
- Automatically falls back to JSONL in unavailable environments (`~/.deepcode/memory.jsonl`)

## Automatic distillation (rule-based, no model calls)

- **Session end** (finalizeMemory): extracts user preferences ("always/never/avoid/please make sure…") and key decisions ("decided/adopted/final plan…")
- **Compaction link**: compacted turns are distilled into L1 before folding (zero information loss)
- **Deduplication**: FTS hits or text containment determine duplicates, avoiding noise accumulation
- **Importance scoring**: preference 0.8 / fact 0.6 / experience 0.5 / episode 0.4

## Retrieval (three-strategy mix)

1. SQL exact/LIKE
2. **FTS5 keywords** (weighted 1.5; queries are safely escaped, falls back to LIKE on failure)
3. Semantic embeddings: pluggable (stretch; local transformers.js or provider embedding API)

Ranking: `fts_hit × 1.5 + importance × 0.5 + recency decay (30-day half-life) × 0.3 + access frequency × 0.2`

## Injection and tools

- At session start, retrieves top-k (`memory.injectTopK`, default 4) and injects into the "relevant memories" section of the system prompt (stable within the session, does not break the cache prefix)
- `--continue` session resume injects the same way
- Tools: `memory_save` / `memory_search` / `memory_list` / `memory_forget`
- CLI: `deepcode memory status|list|search|forget|extract`
