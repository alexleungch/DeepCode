import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { renderMarkdown, clipLine } from '../markdown.js';
import type { MessageView, ToolCallView } from '../state.js';

/** One rendered row of a message (line-level unit). */
interface MsgLine {
  id: string;
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
  indent?: number;
}

function iconOf(status: ToolCallView['status']): string {
  return status === 'done' ? '✓' : status === 'error' ? '✗' : status === 'denied' ? '⊘' : status === 'streaming' ? '…' : '⠋';
}
function colorOf(status: ToolCallView['status']): string {
  return status === 'error' ? theme.error : status === 'done' ? theme.success : theme.primary;
}

/** Build the flat line list for an assistant message. */
function buildLines(m: MessageView, width: number): MsgLine[] {
  const out: MsgLine[] = [];
  renderMarkdown(m.text).forEach((l, i) => {
    out.push({
      id: `md-${i}`,
      text: l.text,
      color: l.kind.startsWith('h') ? theme.primary : theme.assistant,
      bold: l.kind.startsWith('h'),
    });
  });
  if (m.thinking) {
    out.push({ id: 'thinking', text: `… ${m.thinking.replace(/\n/g, ' ').slice(-400)}`, color: theme.thinking, italic: true });
  }
  for (const tc of m.toolCalls) {
    let argsText = '';
    try {
      argsText = tc.inputJson ? JSON.stringify(JSON.parse(tc.inputJson)) : Object.keys(tc.input).length ? JSON.stringify(tc.input) : '';
    } catch {
      argsText = tc.inputJson;
    }
    const args = clipLine(argsText, Math.max(20, width - 16));
    out.push({
      id: `tc-${tc.callId}`,
      text: `${iconOf(tc.status)} ${tc.name} ${args}${tc.durationMs ? ` (${tc.durationMs}ms)` : ''}`,
      color: colorOf(tc.status),
      indent: 2,
    });
    if (tc.result && !tc.result.isError) {
      if (tc.result.diff) {
        const diffLines = tc.result.diff.split('\n').slice(0, 30);
        diffLines.forEach((l, i) => {
          let color: string = theme.muted;
          if (l.startsWith('+')) color = theme.diffAdd;
          else if (l.startsWith('-')) color = theme.diffDel;
          else if (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++')) color = theme.diffHunk;
          out.push({ id: `df-${tc.callId}-${i}`, text: clipLine(l, width), color, indent: 2 });
        });
        if (tc.result.diff.split('\n').length > 30) {
          out.push({ id: `df-${tc.callId}-more`, text: '… (diff too long, folded)', color: theme.muted, indent: 2 });
        }
      } else {
        tc.result.content.split('\n').slice(0, 3).forEach((l, i) => {
          out.push({ id: `res-${tc.callId}-${i}`, text: clipLine(l, width), color: theme.muted, indent: 2 });
        });
      }
    } else if (tc.result?.isError) {
      tc.result.content.split('\n').slice(0, 4).forEach((l, i) => {
        out.push({ id: `err-${tc.callId}-${i}`, text: l, color: theme.error, indent: 2 });
      });
    }
  }
  if (m.streaming) out.push({ id: 'spinner', text: '⠋', color: theme.muted });
  return out;
}

function AssistantMessage({ m, width }: { m: MessageView; width: number }) {
  const lines = buildLines(m, width);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((l) => (
        <Text key={l.id} color={l.color} bold={l.bold} italic={l.italic}>
          {l.indent ? '  ' + l.text : l.text}
        </Text>
      ))}
    </Box>
  );
}

function UserMessage({ m }: { m: MessageView }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.user} bold>
        ❯ {m.text}
      </Text>
    </Box>
  );
}

/** One message entry, used by the merged message list. */
export function MessageItem({ m, width }: { m: MessageView; width: number }) {
  if (m.role === 'user') return <UserMessage m={m} />;
  if (m.role === 'assistant') return <AssistantMessage m={m} width={width} />;
  return <Text color={theme.muted}>{m.text}</Text>;
}

/** Message stream view (only the most recent N messages render, for performance) */
export function MessageList({ messages, width }: { messages: MessageView[]; width: number }) {
  const visible = messages.slice(-30);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((m) => (
        <Box key={m.id} flexDirection="column">
          <MessageItem m={m} width={width} />
        </Box>
      ))}
    </Box>
  );
}
