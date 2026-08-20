import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { renderMarkdown, clipLine } from '../markdown.js';
import { useSpinnerFrame } from './spinner.js';
import { ToolCard } from './ToolCard.js';
import { ImageCard, detectImageRef } from './ImageCard.js';
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

/**
 * Memoized markdown line builder. Messages in TUI state are immutable (the reducer replaces the
 * message object whenever its text/thinking/toolCalls change, and reuses the SAME object reference
 * for untouched messages — see the identity-preserving tool-* cases in state.ts), so caching by
 * object identity never goes stale. This removes the per-render regex re-parse of every message:
 * buildMarkdownLines is called by BOTH the renderer and the row estimator (virtual-scroll), i.e.
 * several times per render for a long conversation.
 */
const mdLinesCache = new WeakMap<MessageView, MdLine[]>();

/** Build the flat line list for the markdown part of an assistant message. Exported for row-height
 *  estimation (virtual scrolling) — each line renders as (roughly) one terminal row. */
export function buildMarkdownLines(m: MessageView): MdLine[] {
  const cached = mdLinesCache.get(m);
  if (cached) return cached;
  const out: MdLine[] = [];
  renderMarkdown(m.text).forEach((l, i) => {
    if (l.kind === 'code') {
      // Code block: single line per output line, dim background + language label header
      if (l.codeLang) {
        out.push({ id: `md-${i}-lang`, text: `┌─ ${l.codeLang}`, color: theme.muted, indent: 2 });
      }
      l.text.split('\n').forEach((line, j) => {
        out.push({ id: `md-${i}-${j}`, text: line || ' ', color: theme.code, indent: 2, bg: theme.codeBg });
      });
      if (l.codeLang) {
        out.push({ id: `md-${i}-lang-end`, text: '└─', color: theme.muted, indent: 2 });
      }
      return;
    }
    // Headings get a visual hierarchy: h1 = bold primary, h2 = primary, h3 = bold assistant.
    // (Terminals can't vary font size, so weight + color carry the level distinction.)
    const heading = l.kind.startsWith('h');
    const headingStyle =
      l.kind === 'h1'
        ? { color: theme.primary, bold: true }
        : l.kind === 'h2'
          ? { color: theme.primary, bold: false }
          : { color: theme.assistant, bold: true };
    out.push({
      id: `md-${i}`,
      text: l.text,
      color: heading ? headingStyle.color : theme.assistant,
      bold: heading ? headingStyle.bold : undefined,
      segments: l.segments,
    });
  });
  mdLinesCache.set(m, out);
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
  // After the turn thinking is normally collapsed (revealed only via Ctrl+O). But when the model
  // produced ONLY reasoning — no text, no tool calls — that thinking IS the answer, so render it
  // in full instead of leaving an empty reply. Tool turns keep thinking collapsed (it is just
  // pre-tool reasoning; the answer arrives as text after the tools run).
  const thinkingOnlyAnswer = !m.text && m.toolCalls.length === 0;
  if (expanded || thinkingOnlyAnswer) {
    const raw = thinkingOnlyAnswer ? m.thinking : m.thinking.slice(-400);
    const t = clipLine(raw.replace(/\n/g, ' '), Math.max(20, width));
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
  maxLines,
}: {
  m: MessageView;
  width: number;
  expandedCallId?: string;
  expandedThinking?: boolean;
  /** Cap the markdown lines rendered from this message to the first N (viewport overflow guard). */
  maxLines?: number;
}) {
  const mdLines = maxLines !== undefined ? buildMarkdownLines(m).slice(0, maxLines) : buildMarkdownLines(m);
  // Detect image references in the message text for inline display
  const imageRef = m.text ? detectImageRef(m.text) : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {mdLines.map((l) => (
        <Text key={l.id} color={l.color} bold={l.bold} italic={l.italic} backgroundColor={l.bg}>
          {l.segments && l.segments.length > 0 ? (
            <>
              {l.indent ? '  ' : null}
              {l.segments.map((s, i) => (
                <Text
                  key={i}
                  bold={s.bold}
                  italic={s.italic}
                  color={s.code ? theme.code : s.link ? theme.primary : undefined}
                  underline={s.link}
                  // Inline code gets the same background as code blocks so it stays visible on
                  // light themes (where theme.code == theme.assistant would otherwise be invisible).
                  backgroundColor={s.code ? theme.codeBg : undefined}
                >
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
      {/* Render detected image reference as an inline card */}
      {imageRef ? <ImageCard info={imageRef} width={width} /> : null}
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

/** One message entry, used by the merged message list.
 *  Memoized: during a streamed turn only the LAST message changes identity (the reducer reuses
 *  prior message objects), so settled history skips re-render on every text/tool delta. The
 *  default shallow comparison is correct because `m` is immutable in TUI state. */
export const MessageItem = React.memo(function MessageItem({
  m,
  width,
  expandedCallId,
  expandedThinkingId,
  maxLines,
}: {
  m: MessageView;
  width: number;
  expandedCallId?: string;
  expandedThinkingId?: number;
  /** Cap the markdown lines rendered from this message to the first N (viewport overflow guard). */
  maxLines?: number;
}) {
  if (m.role === 'user') return <UserMessage m={m} />;
  if (m.role === 'assistant')
    return (
      <AssistantMessage m={m} width={width} expandedCallId={expandedCallId} expandedThinking={expandedThinkingId === m.id} maxLines={maxLines} />
    );
  return <Text color={theme.muted}>{m.text}</Text>;
});
