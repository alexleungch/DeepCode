import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TUIState } from '../state.js';
import { basename } from 'node:path';

/** Shorten a workspace path to its basename when it is long or the terminal is narrow. */
function shortPath(p: string): string {
  return p.length > 32 ? basename(p) : p;
}

/**
 * Minimal top Header — only global context, per the layout spec:
 *   <model>  ⎇ <git branch>  in <cwd>
 * A dim rule line closes it off from the main area. On narrow terminals the cwd
 * (and, below a tighter threshold, the branch) drop out so the core context stays visible.
 */
export function Header({ state, width }: { state: TUIState; width: number }) {
  const narrow = width < 72;
  const tiny = width < 48;
  const branch = state.branch ?? '—';
  const cwd = shortPath(state.workspace);
  const rule = '─'.repeat(Math.max(0, Math.floor(width)));

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      <Box gap={1}>
        <Text bold color={theme.primary}>
          {state.model}
        </Text>
        {!tiny && (
          <Text color={theme.accent}>
            ⎇ {branch}
          </Text>
        )}
        {!narrow && (
          <Text color={theme.muted}>
            in {cwd}
          </Text>
        )}
      </Box>
      <Text color={theme.muted}>{rule}</Text>
    </Box>
  );
}
