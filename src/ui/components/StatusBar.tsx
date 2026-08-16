import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TUIState } from '../state.js';
import type { PermissionMode } from '../../config/types.js';
import { formatTokens } from '../../agent/token-budget.js';
import { basename } from 'node:path';

function contextBar(ratio: number): string {
  const width = 16;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;

/** Mode badge shown in the status bar. ask (the default) is labeled AUTO so the user can always
 *  see at a glance whether the agent is in normal execution or PLAN mode. */
const MODE_BADGE: Record<PermissionMode, { label: string; color: string }> = {
  ask: { label: 'AUTO', color: theme.success },
  acceptEdits: { label: 'EDIT', color: theme.success },
  plan: { label: 'PLAN', color: theme.warning },
  bypassPermissions: { label: 'BYPASS', color: theme.error },
};

/**
 * Animated spinner frame while a request is running.
 *
 * A plain glyph would render once and freeze because no events fire during e.g. a slow tool run.
 * The interval lives for the whole component lifetime and only advances the visible frame while
 * `busy` is true (a ref avoids re-rendering while idle). This is more reliable than starting the
 * interval in a `useEffect` gated on `busy`: the effect restarts every time busy toggles (turns,
 * approval dialogs), and between restarts the icon can look frozen.
 */
function useSpinnerFrame(busy: boolean): string {
  const [tick, setTick] = useState(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const id = setInterval(() => {
      // Returning the same tick while idle makes React bail out (no re-render).
      setTick((t) => (busyRef.current ? t + 1 : t));
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
}

/** Elapsed seconds of the current busy period (0 when idle). */
function useElapsed(busy: boolean): number {
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
  return elapsed;
}

/** Shorten a workspace path to its basename when it is long. */
function shortPath(p: string): string {
  return p.length > 40 ? basename(p) : p;
}

/** Bottom status bar: model/provider · directory · mode · tokens and cost · context usage */
export function StatusBar({ state }: { state: TUIState }) {
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

  return (
    <Box borderStyle="round" borderColor={over ? 'yellow' : 'gray'} paddingX={1} flexDirection="column" flexShrink={0}>
      <Box gap={2}>
        <Text color={theme.primary} bold>
          {state.model}
        </Text>
        <Text color={theme.muted}>
          {state.provider} · {shortPath(state.workspace)}
        </Text>
        <Text color={badge.color} bold>
          [{badge.label}]
        </Text>
        {state.busy ? (
          <Text color={theme.warning}>
            {spinner} Running{elapsed > 0 ? ` ${elapsed}s` : ''}
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
        <Text color={theme.muted}>{state.lastStopReason ?? ''}</Text>
      </Box>
    </Box>
  );
}
