import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { clipLine } from '../markdown.js';
import { useSpinnerFrame } from './spinner.js';
import type { ToolCallView } from '../state.js';

/**
 * Tool card: a Claude-Code-style single-line header (icon + bold name + friendly summary,
 * dim duration right-aligned) followed by the tool result with ⎿-prefixed lines.
 *
 * The old renderer dumped raw JSON args; this one derives a per-tool human summary from the
 * (possibly still-streaming) input JSON, so the card reads like "⠋ Read (src/foo.ts)" instead of
 * "⠋ read_file {"path":"a.ts","offset":0}".
 *
 * Improvements over baseline:
 * - Error cards show a visible error icon (✗) with error color in the header
 * - Denied cards show ⊘ with muted color
 * - Very long summaries are clipped more aggressively to prevent header overflow
 * - Duration shows "ms" or "s" with proper formatting
 * - Empty results show a placeholder instead of blank space
 */

type ToolFamily = 'read' | 'edit' | 'exec' | 'search' | 'other';

function toolFamily(name: string): ToolFamily {
  switch (name) {
    case 'read_file':
    case 'browser_review':
      return 'read';
    case 'write_file':
    case 'edit_file':
      return 'edit';
    case 'run_terminal_cmd':
      return 'exec';
    case 'glob':
    case 'grep':
      return 'search';
    case 'todo_write':
    case 'task':
    case 'skill':
    case 'ask_user':
    case 'subtasks':
      return 'other';
    default:
      return 'other';
  }
}

function familyColor(f: ToolFamily): string {
  switch (f) {
    case 'read':
      return theme.toolRead;
    case 'edit':
      return theme.toolEdit;
    case 'exec':
      return theme.toolExec;
    case 'search':
      return theme.toolSearch;
    default:
      return theme.toolOther;
  }
}

/** Display name (Claude Code style) for a tool, e.g. run_terminal_cmd → Bash. */
function displayName(name: string): string {
  switch (name) {
    case 'read_file':
      return 'Read';
    case 'write_file':
      return 'Write';
    case 'edit_file':
      return 'Edit';
    case 'run_terminal_cmd':
      return 'Bash';
    case 'glob':
      return 'Glob';
    case 'grep':
      return 'Grep';
    case 'todo_write':
      return 'TodoWrite';
    case 'ask_user':
      return 'AskUser';
    case 'task':
      return 'Task';
    case 'skill':
      return 'Skill';
    case 'browser_review':
      return 'Browser';
    case 'subtasks':
      return 'Subtasks';
    default:
      // Capitalize first letter for unknown tools: "my_tool" → "My_tool"
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

/** First string value in an args object (fallback summary for unknown tools). */
function firstStringArg(input: Record<string, unknown>): string | undefined {
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * Best-effort merge of the final args and the streaming partial JSON.
 * While the model emits tool-input-delta, `inputJson` accumulates a (possibly truncated) JSON
 * string; the last committed key/value pairs are extracted so the summary stays live. When the
 * parse fails completely we fall back to the one-shot `input` (or nothing → "…").
 */
function mergedArgs(tc: ToolCallView): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...tc.input };
  if (!tc.inputJson) return merged;
  try {
    return { ...merged, ...(JSON.parse(tc.inputJson) as Record<string, unknown>) };
  } catch {
    // Truncated mid-stream: salvage the completed (and the trailing unterminated) key/value pairs.
    const re = /"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*"?|[\w.+-]+|true|false|null)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tc.inputJson))) {
      const [, k, v] = m;
      // v may be `"value"` (closed) or `"value` (cut off mid-stream): strip the leading quote and
      // the trailing quote only when present.
      merged[k!] = v!.startsWith('"') ? (v!.endsWith('"') ? v!.slice(1, -1) : v!.slice(1)) : v;
    }
    return merged;
  }
}

/** Count added/removed lines in a unified diff (excluding the +++/--- file headers). */
function diffStats(diff: string): [number, number] {
  let add = 0;
  let del = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return [add, del];
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Human-friendly one-line summary of what the tool is doing / did.
 * `maxColumns` caps the DISPLAY width (CJK-safe via clipByWidth); the composed
 * result (path + stats suffix) is clipped as a whole, so the header never exceeds it.
 * Default 80 keeps callers/tests that don't care about width stable.
 */
export function friendlySummary(tc: ToolCallView, maxColumns = 80): string {
  const input = mergedArgs(tc);
  let out: string;
  switch (tc.name) {
    case 'read_file': {
      const p = typeof input.path === 'string' ? input.path : firstStringArg(input);
      if (tc.status === 'done' && tc.result && !tc.result.isError) {
        const m = /\((\d+) lines total\)/.exec(tc.result.content);
        if (m) {
          out = `${p ?? 'file'} (+${m[1]} lines)`;
          break;
        }
      }
      out = p ?? '…';
      break;
    }
    case 'write_file':
    case 'edit_file': {
      const p = typeof input.path === 'string' ? input.path : firstStringArg(input);
      if (tc.status === 'done' && tc.result?.diff) {
        const [add, del] = diffStats(tc.result.diff);
        out = `${p ?? 'file'} (++${add} −${del})`;
        break;
      }
      out = p ?? '…';
      break;
    }
    case 'run_terminal_cmd': {
      const c = typeof input.command === 'string' ? input.command : firstStringArg(input);
      out = c ?? '…';
      break;
    }
    case 'glob':
    case 'grep': {
      const p = typeof input.pattern === 'string' ? input.pattern : firstStringArg(input);
      out = p ?? '…';
      break;
    }
    case 'task': {
      const label = typeof input.label === 'string' ? input.label : undefined;
      const task = typeof input.task === 'string' ? input.task : undefined;
      out = label ?? task ?? '…';
      break;
    }
    default: {
      out = firstStringArg(input) ?? '…';
    }
  }
  return clipLine(out, maxColumns);
}

/** Terminal-state icon (spinner while streaming/running). */
function statusIcon(status: ToolCallView['status']): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'error':
      return '✗';
    case 'denied':
      return '⊘';
    default:
      return '…';
  }
}

function statusColor(status: ToolCallView['status']): string {
  switch (status) {
    case 'done':
      return theme.success;
    case 'error':
      return theme.error;
    case 'denied':
      return theme.muted;
    default:
      return '';
  }
}

/** Result body lines (⎿-prefixed; unified-diff coloring preserved).
 *  Improvements:
 *  - Empty results show a "(empty)" placeholder instead of blank space
 *  - Single-line results that are very long get clipped properly
 *  - Error results always show at least a few lines (even if isError with no content)
 *  - Diff hunk headers (@@) use italic styling for better visual separation
 *  - File headers (+++/---) get distinct styling from hunk headers
 */
function ResultLines({ tc, expanded, width }: { tc: ToolCallView; expanded: boolean; width: number }) {
  const result = tc.result;
  if (!result) return null;
  const isErr = !!result.isError;
  const rawLines = result.diff ? result.diff.split('\n') : result.content.split('\n');
  // Filter out truly empty trailing lines but keep intentional blank lines
  const lines = rawLines.filter((_, i, arr) => i < arr.length - 1 || _ !== '');
  const cap = expanded ? lines.length : result.diff ? 30 : isErr ? 4 : 3;
  const shown = lines.slice(0, cap);
  const colorOf = (l: string): string => {
    if (isErr) return theme.error;
    if (result!.diff) {
      if (l.startsWith('+')) return theme.diffAdd;
      if (l.startsWith('-')) return theme.diffDel;
      if (l.startsWith('@@')) return theme.diffHunk;
      // File headers in unified diff: +++ new_file, --- old_file
      if (l.startsWith('+++') || l.startsWith('---')) return theme.diffHunk;
      // No newline at end of file marker
      if (l.startsWith('\\ No newline')) return theme.muted;
    }
    return theme.muted;
  };
  // Handle completely empty results
  if (lines.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={isErr ? theme.error : theme.muted}>
          ⎿ {(isErr ? '(no error message)' : '(empty result)')}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => (
        <Text key={i} color={colorOf(l)} italic={!!(result?.diff && l.startsWith('@@'))}>
          ⎿ {clipLine(l, Math.max(16, width - 2))}
        </Text>
      ))}
      {!expanded && lines.length > cap ? (
        <Text color={isErr ? theme.error : theme.muted}>
          ⎿ … ({result.diff ? 'diff' : `${lines.length} lines`} — Ctrl+O to expand)
        </Text>
      ) : null}
    </Box>
  );
}

/** Live output from a running tool (bash stdout/stderr tail). */
function ProgressLines({ tc, width }: { tc: ToolCallView; width: number }) {
  if (!tc.progress || (tc.status !== 'streaming' && tc.status !== 'running')) return null;
  const tail = tc.progress.replace(/\n+$/, '').split('\n').slice(-3);
  return (
    <Box flexDirection="column">
      {tail.map((l, i) => (
        <Text key={i} color={theme.muted}>
          ⎿ {clipLine(l, Math.max(16, width - 2))}
        </Text>
      ))}
    </Box>
  );
}

/** Tool card. Memoized: only the card whose callId changed re-renders on tool deltas — all other
 *  cards keep the same `tc` reference (the reducer updates one message's toolCalls in place). */
export const ToolCard = React.memo(function ToolCard({ tc, width, expanded }: { tc: ToolCallView; width: number; expanded: boolean }) {
  const spinning = tc.status === 'streaming' || tc.status === 'running';
  const frame = useSpinnerFrame(spinning);
  const icon = spinning ? frame : statusIcon(tc.status);
  const family = toolFamily(tc.name);
  const color = familyColor(family);
  const name = displayName(tc.name);
  const duration = tc.durationMs ? fmtDuration(tc.durationMs) : '';

  // Header: `<icon> <bold name> (summary)` + dim duration pushed to the right edge.
  // The summary is clipped to the ACTUAL available columns so the single-line header
  // never wraps on narrow terminals (the old fixed 80-char clip ignored `width`).
  // Reserve: icon(1) + space(1) + name + parens(2) + min pad(1) + duration + border padding(2).
  const namePart = `${name}`;
  const summaryMax = Math.max(8, width - (icon.length + 1 + namePart.length + 2 + 1 + duration.length + 2));
  const summary = friendlySummary(tc, summaryMax);
  const summaryPart = ` (${summary})`;
  const headerLen = icon.length + 1 + namePart.length + summaryPart.length;
  const pad = Math.max(1, width - headerLen - duration.length - 2);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color={spinning ? color : statusColor(tc.status) || color}>
          {icon}{' '}
        </Text>
        <Text bold color={color}>
          {namePart}
        </Text>
        <Text color={color}>
          {summaryPart}
          {' '.repeat(pad)}
        </Text>
        <Text dimColor>{duration}</Text>
      </Text>
      <ProgressLines tc={tc} width={width} />
      <ResultLines tc={tc} expanded={expanded} width={width} />
    </Box>
  );
});
