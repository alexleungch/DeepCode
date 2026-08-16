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
  /** Per-run styled segments (markdown inline styles) — takes precedence over plain text */
  segments?: import('../markdown.js').StyledSegment[];
  indent?: number;
  /** Background color for code blocks */
  bg?: string;
}

function iconOf(status: ToolCallView['status']): string {
  return status === 'done' ? '✓' : status === 'error' ? '✗' : status === 'denied' ? '⊘' : status === 'streaming' ? '…' : '⠋';
}
function colorOf(status: ToolCallView['status']): string {
  return status === 'error' ? theme.error : status === 'done' ? theme.success : theme.primary;
}

/** Build the flat line list for an assistant message. */
function buildLines(m: MessageView, width: number, expandedCallId?: string): MsgLine[] {
  const out: MsgLine[] = [];
  renderMarkdown(m.text).forEach((l, i) => {
    if (l.kind === 'code') {
      // Code block: single line per output line, dim background + language label header
      if (l.codeLang) {
        out.push({ id: `md-${i}-lang`, text: `┌─ ${l.codeLang}`, color: theme.muted, indent: 2 });
      }
      l.text.split('\n').forEach((line, j) => {
        out.push({ id: `md-${i}-${j}`, text: line || ' ', color: theme.code, indent: 2, bg: '#161b22' });
      });
      if (l.codeLang) {
        out.push({ id: `md-${i}-lang-end`, text: '└─', color: theme.muted, indent: 2 });
      }
      return;
    }
    const isHeading = l.kind.startsWith('h');
    out.push({
      id: `md-${i}`,
      text: l.text,
      color: isHeading ? theme.primary : theme.assistant,
      bold: isHeading,
      segments: l.segments,
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
    // Live progress from a running tool (bash stdout/stderr) — show only the tail so a chatty
    // command cannot flood the live region; the full stream is still visible in the tool result.
    if (tc.progress && (tc.status === 'streaming' || tc.status === 'running')) {
      const tail = tc.progress.replace(/\n+$/, '').split('\n').slice(-3);
      tail.forEach((l, i) => {
        out.push({ id: `pr-${tc.callId}-${i}`, text: clipLine(l, Math.max(20, width - 8)), color: theme.muted, indent: 4 });
      });
    }
    if (tc.result) {
      const result = tc.result;
      const expanded = expandedCallId === tc.callId;
      const isErr = !!result.isError;
      const lines = result.diff ? result.diff.split('\n') : result.content.split('\n');
      const cap = expanded ? lines.length : result.diff ? 30 : isErr ? 4 : 3;
      const shown = lines.slice(0, cap);
      shown.forEach((l, i) => {
        let color: string = isErr ? theme.error : theme.muted;
        if (result.diff) {
          if (l.startsWith('+')) color = theme.diffAdd;
          else if (l.startsWith('-')) color = theme.diffDel;
          else if (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++')) color = theme.diffHunk;
        }
        out.push({ id: `${tc.callId}-r-${i}`, text: clipLine(l, width), color, indent: 2 });
      });
      if (!expanded && lines.length > cap) {
        const hint = result.diff ? 'diff' : `${lines.length} lines`;
        out.push({ id: `${tc.callId}-r-more`, text: `… (${hint} — Ctrl+O to expand)`, color: isErr ? theme.error : theme.muted, indent: 2 });
      }
    }
  }
  if (m.streaming) out.push({ id: 'spinner', text: '⠋', color: theme.muted });
  return out;
}

function AssistantMessage({ m, width, expandedCallId }: { m: MessageView; width: number; expandedCallId?: string }) {
  const lines = buildLines(m, width, expandedCallId);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((l) => (
        <Text key={l.id} color={l.color} bold={l.bold} italic={l.italic} backgroundColor={l.bg}>
          {l.segments && l.segments.length > 0 ? (
            <>
              {l.indent ? '  ' : null}
              {l.segments.map((s, i) => (
                <Text key={i} bold={s.bold} italic={s.italic} color={s.code ? theme.code : s.link ? theme.primary : undefined} underline={s.link}>
                  {s.text}
                </Text>
              ))}
            </>
          ) : (
            <>
              {l.indent ? '  ' + l.text : l.text}
            </>
          )}
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
export function MessageItem({ m, width, expandedCallId }: { m: MessageView; width: number; expandedCallId?: string }) {
  if (m.role === 'user') return <UserMessage m={m} />;
  if (m.role === 'assistant') return <AssistantMessage m={m} width={width} expandedCallId={expandedCallId} />;
  return <Text color={theme.muted}>{m.text}</Text>;
}

/** Message stream view (only the most recent N messages render, for performance) */
export function MessageList({ messages, width, expandedCallId }: { messages: MessageView[]; width: number; expandedCallId?: string }) {
  const visible = messages.slice(-30);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((m) => (
        <Box key={m.id} flexDirection="column">
          <MessageItem m={m} width={width} expandedCallId={expandedCallId} />
        </Box>
      ))}
    </Box>
  );
}
