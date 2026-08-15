import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

export interface PromptInputProps {
  disabled: boolean;
  onSubmit(text: string): void;
  placeholder?: string;
}

/** Slash commands available in the TUI (used for Tab completion) */
export const SLASH_COMMANDS = ['help', 'key', 'models', 'cost', 'usage', 'context', 'compact', 'clear', 'exit', 'quit'];

/** Slash-command candidates matching the current input ("" prefix matches all) */
function commandMatches(value: string): string[] {
  const m = /^\/([a-zA-Z][a-zA-Z0-9-]*)?$/.exec(value);
  if (!m) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(m[1]?.toLowerCase() ?? ''));
}

/** Terminal input: multi-line paste, up/down history, /command Tab completion */
export function PromptInput({ disabled, onSubmit, placeholder }: PromptInputProps) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      const text = value.trim();
      if (text) {
        setHistory((h) => [text, ...h].slice(0, 50));
        setHistIdx(-1);
        setValue('');
        onSubmit(text);
      }
      return;
    }
    if (key.tab) {
      // Cycle through the matching slash commands; repeated Tab advances to the next match
      setValue((v) => {
        const matches = commandMatches(v);
        if (matches.length === 0) return v;
        const current = v.slice(1).toLowerCase();
        const idx = matches.indexOf(current);
        const next = matches[(idx + 1) % matches.length];
        return next ? '/' + next : v;
      });
      return;
    }
    if (key.backspace || key.delete) {
      // Ink 6 parses the terminal-sent \x7f (the Backspace key on most terminals) as delete
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.upArrow) {
      setHistIdx((i) => {
        const next = i + 1;
        const item = history[next];
        if (item !== undefined) setValue(item);
        return Math.min(next, history.length - 1);
      });
      return;
    }
    if (key.downArrow) {
      setHistIdx((i) => {
        const next = i - 1;
        if (next < 0) {
          setValue('');
          return -1;
        }
        const item = history[next];
        if (item !== undefined) setValue(item);
        return next;
      });
      return;
    }
    if (key.escape) return;
    if (input) setValue((v) => v + input);
  });

  useEffect(() => {
    if (disabled) setValue('');
  }, [disabled]);

  return (
    <Box flexShrink={0}>
      <Text color={theme.primary} bold>
        ❯{' '}
      </Text>
      <Text wrap="truncate">{value || <Text color={theme.muted}>{placeholder ?? 'Type a message…'}</Text>}</Text>
    </Box>
  );
}
