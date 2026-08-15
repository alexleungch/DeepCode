# Prompt Caching and Automatic Context Compaction

## 1. Prompt Caching (the core of cost optimization)

### Per-provider strategies

| Provider | Mechanism | Hit reporting |
|---|---|---|
| Anthropic | Explicit `cache_control` breakpoints (≤4/request, TTL 5m) | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| DeepSeek | Server-side automatic prefix caching | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| Gemini | Server-side automatic prefix caching | `cachedContentTokenCount` |
| Grok/compatible endpoints | Server-side automatic (no explicit control) | Best effort (billed as input when unreported) |
| Ollama | `keep_alive` resident + in-session KV reuse | None (free locally) |

### Anthropic breakpoint planner (caching/breakpoint-planner.ts)

Places `cache_control` breakpoints by rule (up to 4):
1. **System prompt** (`index: -1`) — the largest stable region
2. **Last turn's final tool_result** — a stable region reused across turns
3. **The longest user message** (>4000 characters)
4. Rebuilds the breakpoint on the latest tool_result automatically after a TTL timeout

### Prefix stability discipline (prefix-stabilizer design principles)

Cache hits require **exact prefix equality**, therefore:
- System prompt section order is fixed (persona → environment → project docs → memory digest → skill catalog → tool catalog → output contract → safety rules), no timestamps
- Tool schema key order is determinized (`stableSort` recursive sort)
- Session messages are strictly append-only; compaction only rewrites the session region, **never modifies the system prompt or tool schemas**
- Session resume (--continue) keeps messages as-is → the prefix matches the previous session
- The memory digest is injected only at session start (stable within the session)

### Metrics and display

- Hit rate: `cacheRead / inputTokens` (Anthropic/Gemini), `hit / (hit+miss)` (DeepSeek)
- The status bar shows `cache↗` cumulative hits in real time; the `/cost` dashboard shows hit rate and estimated savings
- `~/.deepcode/logs/usage.jsonl` contains per-request cache details, auditable

## 2. Automatic Context Compaction

### Trigger

- Estimated before every request and after each turn (gpt-tokenizer + provider usage calibration)
- Triggered when exceeding `context.compactAt` (70% of the window by default, e.g. 200k→140k)
- Config: `context.autoCompact` / `keepRecentTurns` (default 5) / `maxSummaryTokens` (default 3% of the window)
- `/compact` manual trigger

### Execution order

1. Trim oversized tool_results (keep first N characters + truncation marker)
2. Fold the oldest turns into a `<summary>` structured summary block (goals/decisions/file changes/open questions)
3. Keep the most recent N turns as-is
4. **Distill before compacting**: facts from the compacted turns are extracted into L1 working memory via the memory pipeline (zero information loss)
5. Produce a `CompactionPlan` and emit a `compacted` event (before/after tokens, savings, memory entries)

### Cache interplay

Compaction invalidates the old prefix (cache rebuild). Mitigations:
- The summary block template is byte-stable (same structure)
- After compaction, the new prefix progressively rebuilds cache; the hit-rate trend is visible
- Compaction never touches the system prompt (most of the prefix of the next request can still hit)

### Fallback

- Still over budget after compaction → truncate the largest message → still over → reject the request with a clear error (never silently drop messages)
