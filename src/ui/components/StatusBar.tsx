import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TUIState } from '../state.js';
import { formatTokens } from '../../agent/token-budget.js';

function contextBar(ratio: number): string {
  const width = 16;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Bottom status bar: model/provider · directory · tokens and cost · context usage · permission mode */
export function StatusBar({ state }: { state: TUIState }) {
  const u = state.usage;
  const cost = u.costUsd < 0.01 ? `$${u.costUsd.toFixed(4)}` : `$${u.costUsd.toFixed(2)}`;
  const cacheHit = u.cacheReadTokens + u.promptCacheHitTokens;
  // Cache hit rate: fraction of total input tokens served from cache (clamped 0-100%)
  const cachePct = u.inputTokens > 0 && cacheHit > 0 ? Math.min(100, Math.round((cacheHit / u.inputTokens) * 100)) : 0;
  const pct = Math.round(state.contextRatio * 100);
  const over = state.contextRatio >= 0.7;
  return (
    <Box borderStyle="round" borderColor={over ? 'yellow' : 'gray'} paddingX={1} flexDirection="column" flexShrink={0}>
      <Box gap={2}>
        <Text color={theme.primary} bold>
          {state.model}
        </Text>
        <Text color={theme.muted}>
          {state.provider} · {state.workspace}
        </Text>
        {state.busy ? <Text color={theme.warning}>⠋ Running…</Text> : null}
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
