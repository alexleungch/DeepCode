import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { renderMarkdown, clipLine } from '../markdown.js';
import { useSpinnerFrame } from './spinner.js';
import { ToolCard } from './ToolCard.js';
import type { MessageView } from '../state.js';

/** One rendered row of markdown (line-level unit). */
interface MdLine {
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

/** Build the flat line list for the markdown part of an assistant message. Exported for row-height
 *  estimation (virtual scrolling) — each line renders as (roughly) one terminal row. */
export function buildMarkdownLines(m: MessageView): MdLine[] {
  const out: MdLine[] = [];
  renderMarkdown(m.text).forEach((l, i) => {
    if (l.kind === 'code') {
      // Code block: single line per output line, dim background + language label header
      if (l.codeLang) {
        out.push({ id: `md-${i}-lang`, text: `┌─ ${l.codeLang}`, color: theme.muted, indent: 2 });
      }
      l.text.split('\n').forEach((line, j) => {
        out.push({ id: `md-${i}-${j}`, text: line || ' ', color: theme.code, indent: 2, bg: theme.codeBg ?? '#161b22' });
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
  return out;
}

/**
 * Thinking indicator (Step 4):
 * - While the model is streaming a reasoning phase (thinking present, no text yet): an animated
 *   "⠋ Thinking…" line in theme.thinking italic — no raw reasoning dump.
 * - After the turn: collapsed (hidden) unless the user expands it via Ctrl+O.
 */
function ThinkingLine({ m, expanded, width }: { m: MessageView; expanded: boolean; width: number }) {
  const active = m.streaming && !!m.thinking && !m.text;
  const frame = useSpinnerFrame(active);
  if (!m.thinking) return null;
  if (active) {
    return (
      <Text color={theme.thinking} italic>
        {frame} Thinking…
      </Text>
    );
  }
  if (expanded) {
    const t = clipLine(m.thinking.replace(/\n/g, ' ').slice(-400), Math.max(20, width));
    return (
      <Text color={theme.thinking} italic>
        ⋯ {t}
      </Text>
    );
  }
  return null;
}

function AssistantMessage({
  m,
  width,
  expandedCallId,
  expandedThinking,
}: {
  m: MessageView;
  width: number;
  expandedCallId?: string;
  expandedThinking?: boolean;
}) {
  const mdLines = buildMarkdownLines(m);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {mdLines.map((l) => (
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
            <>{l.indent ? '  ' + l.text : l.text}</>
          )}
        </Text>
      ))}
      <ThinkingLine m={m} expanded={!!expandedThinking} width={width} />
      {m.toolCalls.map((tc) => (
        <ToolCard key={tc.callId} tc={tc} width={width} expanded={expandedCallId === tc.callId} />
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
export function MessageItem({
  m,
  width,
  expandedCallId,
  expandedThinkingId,
}: {
  m: MessageView;
  width: number;
  expandedCallId?: string;
  expandedThinkingId?: number;
}) {
  if (m.role === 'user') return <UserMessage m={m} />;
  if (m.role === 'assistant')
    return <AssistantMessage m={m} width={width} expandedCallId={expandedCallId} expandedThinking={expandedThinkingId === m.id} />;
  return <Text color={theme.muted}>{m.text}</Text>;
}
