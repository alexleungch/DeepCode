import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TodoItem } from '../../tools/native/todo.js';
import { clipLine } from '../markdown.js';

/**
 * Live todo panel (Claude-Code-style): a bordered checklist that tracks the agent's
 * todo_write calls in real time. Rendered while the list is non-empty and at least one
 * item is still open; it disappears once everything is completed (like Claude Code).
 */
export function TodoPanel({ todos, width }: { todos: TodoItem[]; width: number }) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  if (total === 0 || done === total) return null;

  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={theme.accent} bold>
        Todo{' '}
        <Text color={theme.muted} bold={false}>
          · {done}/{total}
        </Text>
      </Text>
      {todos.map((t, i) => {
        const icon = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
        const active = t.status === 'in_progress';
        const color = t.status === 'completed' ? theme.muted : active ? theme.primary : theme.assistant;
        return (
          <Text key={`${i}-${t.content}`} color={color} bold={active} dimColor={t.status === 'completed'}>
            {icon} {clipLine(t.content, Math.max(16, width - 8))}
          </Text>
        );
      })}
    </Box>
  );
}
