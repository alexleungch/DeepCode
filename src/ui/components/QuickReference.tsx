/**
 * Quick reference card for keyboard shortcuts.
 * Rendered as a floating panel when the user presses a help key combination
 * (or can be integrated into the /help output).
 *
 * This is a pure presentation component — all keybinding logic lives in
 * app.tsx (host) and PromptInput.tsx (editor).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

/** Keyboard shortcut group for the quick reference display */
interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string; description: string }[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: '↑/↓', description: 'Move cursor (multi-line) / History (single-line)' },
      { keys: '←/→', description: 'Move cursor left/right' },
      { keys: 'Home/End', description: 'Jump to line start/end' },
      { keys: 'Ctrl+A/E', description: 'Jump to line start/end' },
      { keys: 'PageUp/Down', description: 'Scroll conversation' },
      { keys: 'Ctrl+Home/End', description: 'Jump to top/bottom of history' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: 'Enter', description: 'Submit message' },
      { keys: 'Alt+Enter', description: 'Insert newline' },
      { keys: 'Shift+Enter', description: 'Insert newline' },
      { keys: 'Tab', description: 'Complete command / @-ref path' },
      { keys: 'Ctrl+U', description: 'Delete to line start' },
      { keys: 'Ctrl+K', description: 'Delete to line end' },
      { keys: 'Ctrl+W', description: 'Delete word before cursor' },
      { keys: 'Backspace/Del', description: 'Delete char before/after cursor' },
    ],
  },
  {
    title: 'TUI Controls',
    shortcuts: [
      { keys: 'Shift+Tab', description: 'Cycle permission mode' },
      { keys: 'Ctrl+O', description: 'Expand tool result / thinking' },
      { keys: 'Ctrl+C', description: 'Interrupt run / Exit when idle' },
      { keys: 'ESC', description: 'Cancel / Close panel / Interrupt' },
      { keys: 'Wheel', description: 'Scroll conversation' },
      { keys: 'Ctrl+E', description: 'Expand diff in approval dialog' },
    ],
  },
];

export function QuickReference({ width }: { width: number }) {
  const colWidth = Math.max(20, Math.floor((width - 10) / 2));

  return (
    <Box borderStyle="round" borderColor={theme.primary} paddingX={1} flexDirection="column" flexShrink={0}>
      <Text color={theme.primary} bold>
        ⌨ Keyboard Shortcuts
      </Text>
      {SHORTCUT_GROUPS.map((group) => (
        <Box key={group.title} flexDirection="column" marginTop={0} marginBottom={0}>
          <Text color={theme.accent} bold>
            {group.title}
          </Text>
          {group.shortcuts.map((sc) => (
            <Text key={sc.keys}>
              <Text color={theme.code} bold>{sc.keys.padEnd(14)}</Text>
              {sc.description}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
