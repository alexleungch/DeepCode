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
    default:
      return name;
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

/** Human-friendly one-line summary of what the tool is doing / did. */
export function friendlySummary(tc: ToolCallView): string {
  const input = mergedArgs(tc);
  switch (tc.name) {
    case 'read_file': {
      const p = typeof input.path === 'string' ? input.path : firstStringArg(input);
      if (tc.status === 'done' && tc.result && !tc.result.isError) {
        const m = /\((\d+) lines total\)/.exec(tc.result.content);
        if (m) return `${clipLine(p ?? 'file', 80)} (+${m[1]} lines)`;
      }
      return clipLine(p ?? '…', 80);
    }
    case 'write_file':
    case 'edit_file': {
      const p = typeof input.path === 'string' ? input.path : firstStringArg(input);
      if (tc.status === 'done' && tc.result?.diff) {
        const [add, del] = diffStats(tc.result.diff);
        return `${clipLine(p ?? 'file', 80)} (++${add} −${del})`;
      }
      return clipLine(p ?? '…', 80);
    }
    case 'run_terminal_cmd': {
      const c = typeof input.command === 'string' ? input.command : firstStringArg(input);
      return clipLine(c ?? '…', 80);
    }
    case 'glob':
    case 'grep': {
      const p = typeof input.pattern === 'string' ? input.pattern : firstStringArg(input);
      return clipLine(p ?? '…', 80);
    }
    case 'task': {
      const label = typeof input.label === 'string' ? input.label : undefined;
      const task = typeof input.task === 'string' ? input.task : undefined;
      return label ?? (task ? clipLine(task, 60) : '…');
    }
    default: {
      const s = firstStringArg(input);
      return s ? clipLine(s, 60) : '…';
    }
  }
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

/** Result body lines (⎿-prefixed; unified-diff coloring preserved). */
function ResultLines({ tc, expanded, width }: { tc: ToolCallView; expanded: boolean; width: number }) {
  const result = tc.result;
  if (!result) return null;
  const isErr = !!result.isError;
  const lines = result.diff ? result.diff.split('\n') : result.content.split('\n');
  const cap = expanded ? lines.length : result.diff ? 30 : isErr ? 4 : 3;
  const shown = lines.slice(0, cap);
  const colorOf = (l: string): string => {
    if (isErr) return theme.error;
    if (result.diff) {
      if (l.startsWith('+')) return theme.diffAdd;
      if (l.startsWith('-')) return theme.diffDel;
      if (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++')) return theme.diffHunk;
    }
    return theme.muted;
  };
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => (
        <Text key={i} color={colorOf(l)}>
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

export function ToolCard({ tc, width, expanded }: { tc: ToolCallView; width: number; expanded: boolean }) {
  const spinning = tc.status === 'streaming' || tc.status === 'running';
  const frame = useSpinnerFrame(spinning);
  const icon = spinning ? frame : statusIcon(tc.status);
  const family = toolFamily(tc.name);
  const color = familyColor(family);
  const name = displayName(tc.name);
  const summary = friendlySummary(tc);
  const duration = tc.durationMs ? fmtDuration(tc.durationMs) : '';

  // Header: `<icon> <bold name> (summary)` + dim duration pushed to the right edge.
  const namePart = `${name}`;
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
}
