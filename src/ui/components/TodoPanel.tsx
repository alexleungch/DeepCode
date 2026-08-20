import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TodoItem } from '../../tools/native/todo.js';
import { clipLine } from '../markdown.js';

/** Maximum checklist rows rendered inside the panel; longer lists get a "+N more" tail. */
const MAX_VISIBLE = 8;

/**
 * Live todo panel (Claude-Code-style): a bordered checklist that tracks the agent's
 * todo_write calls in real time. It stays visible for the whole turn — including once every
 * item checks off — so a completed task is explicit (☑ lists) instead of the panel silently
 * vanishing mid-run, which left users unable to tell whether the task finished. The next
 * todo_write (or a new turn) replaces the list. Rendered only while the list is non-empty.
 *
 * Improvements:
 *  - Shows progress percentage when there are items
 *  - Completed items show dimmed text so you can still read what was done
 *  - "All done!" message when all items are completed
 */
/** Live todo panel. Memoized: re-renders only when the todo list reference changes (todo-updated
 * replaces `state.todos` wholesale, so unchanged lists skip re-render during a streamed turn). */
export const TodoPanel = React.memo(function TodoPanel({ todos, width }: { todos: TodoItem[]; width: number }) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  if (total === 0) return null;

  const visible = todos.slice(0, MAX_VISIBLE);
  const hidden = total - visible.length;
  const allDone = done === total && total > 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={theme.accent} bold>
        Todo{' '}
        <Text color={theme.muted} bold={false}>
          · {done}/{total}
        </Text>
        {pct > 0 && pct < 100 ? (
          <Text color={theme.muted} bold={false}>
            {' '}({pct}%)
          </Text>
        ) : null}
        {allDone ? (
          <Text color={theme.success} bold>
            {' '}✓ All done!
          </Text>
        ) : null}
      </Text>
      {visible.map((t, i) => {
        const icon = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
        const active = t.status === 'in_progress';
        const color = t.status === 'completed' ? theme.muted : active ? theme.primary : theme.assistant;
        return (
          <Text key={`${i}-${t.content}`} color={color} bold={active} dimColor={t.status === 'completed'}>
            {icon} {clipLine(t.content, Math.max(16, width - 8))}
          </Text>
        );
      })}
      {hidden > 0 ? (
        <Text color={theme.muted}>… +{hidden} more</Text>
      ) : null}
    </Box>
  );
});
