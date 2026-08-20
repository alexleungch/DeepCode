import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TUIState } from '../state.js';
import type { PermissionMode } from '../../config/types.js';
import { formatTokens } from '../../agent/token-budget.js';
import { useSpinnerFrame } from './spinner.js';
import { clipLine } from '../markdown.js';
import { basename } from 'node:path';

function contextBar(ratio: number): string {
  const width = 16;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Mode badge shown in the status bar. ask (the default) is labeled AUTO so the user can always
 *  see at a glance whether the agent is in normal execution or PLAN mode. */
const MODE_BADGE: Record<PermissionMode, { label: string; color: string }> = {
  ask: { label: 'AUTO', color: theme.muted },
  acceptEdits: { label: 'EDIT', color: theme.success },
  plan: { label: 'PLAN', color: theme.warning },
  bypassPermissions: { label: 'BYPASS', color: theme.error },
};

/** Elapsed seconds of the current busy period (0 when idle).
 *  Returns formatted string: "s" for < 60s, "m:ss" for longer.
 */
function useElapsed(busy: boolean): string {
  const [elapsed, setElapsed] = useState(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);
  if (elapsed < 60) return `${elapsed}s`;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Shorten a workspace path to its basename when it is long. */
function shortPath(p: string): string {
  return p.length > 40 ? basename(p) : p;
}

/** Bottom status bar: model/provider · directory · mode · tokens and cost · context usage
 *
 *  Improvements:
 *  - Shows turn count when > 0
 *  - Better formatting of elapsed time (m:ss for long runs)
 *  - Context bar uses filled proportion more accurately
 *  - Scroll hint is more visible with bold styling
 */
export function StatusBar({ state, scrollHint, width }: { state: TUIState; scrollHint?: string | null; width?: number }) {
  const u = state.usage;
  const cost = u.costUsd < 0.01 ? `${u.costUsd.toFixed(4)}` : `${u.costUsd.toFixed(2)}`;
  const cacheHit = u.cacheReadTokens + u.promptCacheHitTokens;
  // Cache hit rate: fraction of total input tokens served from cache (clamped 0-100%)
  const cachePct = u.inputTokens > 0 && cacheHit > 0 ? Math.min(100, Math.round((cacheHit / u.inputTokens) * 100)) : 0;
  const pct = Math.round(state.contextRatio * 100);
  const over = state.contextRatio >= 0.7;

  const spinner = useSpinnerFrame(state.busy);
  const elapsed = useElapsed(state.busy);
  const badge = MODE_BADGE[state.permissionMode];
  const runningSubs = state.subagents.filter((s) => s.status === 'running').length;
  // Long free-text fields (workspace path, stop reason) are clipped by display width so
  // the status bar never wraps on narrow terminals; `width` comes from the host TUI.
  const cwd = clipLine(shortPath(state.workspace), Math.max(16, (width ?? 80) - 30));
  const stopReason = clipLine(state.lastStopReason ?? '', Math.max(12, (width ?? 80) - 40));
  // Turn count badge (shown after the first turn completes)
  const turnBadge = state.turnCount > 0 ? `#${state.turnCount}` : '';

  return (
    <Box borderStyle="round" borderColor={over ? theme.warning : theme.muted} paddingX={1} flexDirection="column" flexShrink={0}>
      <Box gap={2}>
        <Text color={theme.primary} bold>
          {state.model}{turnBadge && <Text color={theme.muted} bold={false}>{turnBadge}</Text>}
        </Text>
        <Text color={theme.muted}>
          {state.provider} · {cwd}
        </Text>
        <Text color={badge.color} bold>
          [{badge.label}]
        </Text>
        {state.busy ? (
          <Text color={theme.warning}>
            {spinner} Running{elapsed ? ` ${elapsed}` : ''}
          </Text>
        ) : null}
        {state.currentTool ? (
          <Text color={theme.primary}>
            ⚙ {state.currentTool}
          </Text>
        ) : null}
        {runningSubs > 0 ? (
          <Text color={theme.accent}>
            ⎇ {runningSubs} sub
          </Text>
        ) : null}
      </Box>
      <Box gap={3}>
        <Text color={theme.muted}>
          in {formatTokens(u.inputTokens)} / out {formatTokens(u.outputTokens)}
        </Text>
        {cachePct > 0 ? <Text color={theme.success}>cache {cachePct}%</Text> : null}
        <Text color={theme.accent}>{cost}</Text>
        <Text color={over ? theme.error : theme.muted}>
          ctx {contextBar(state.contextRatio)} {pct}%
        </Text>
        <Text color={theme.muted}>{stopReason}</Text>
        {scrollHint ? <Text color={theme.warning} bold>{scrollHint}</Text> : null}
      </Box>
    </Box>
  );
}
