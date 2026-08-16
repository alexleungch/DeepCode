import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import type { ApprovalView } from '../state.js';
import { clipLine } from '../markdown.js';

interface ApprovalCallbacks {
  /** y/n/a/d or an option number */
  decide(itemCallId: string, action: 'allow' | 'deny' | 'allow-always' | 'deny-always', feedback?: string): void;
  /** Decide every remaining item with the same action (A = allow all, D = deny all) */
  decideAll(action: 'allow' | 'deny'): void;
  /** Attach feedback (e mode) */
  setFeedbackMode(on: boolean): void;
  /** Incremental feedback text */
  typeFeedback(ch: string): void;
  backspaceFeedback(): void;
  submitFeedback(): void;
  /** Deny everything and abort */
  abortAll(): void;
  focusNext(delta: number): void;
  /** Toggle full diff display for the focused item */
  toggleDiff(): void;
}

function renderItem(approval: ApprovalView, callbacks: ApprovalCallbacks, width: number, diffExpanded: boolean) {
  const item = approval.items[approval.focusIndex];
  if (!item) return null;
  const focused = !approval.feedbackMode;
  const allDiff = item.diff ? item.diff.split('\n') : [];
  const shownDiff = diffExpanded ? allDiff : allDiff.slice(0, 40);
  return (
    <Box flexDirection="column">
      <Text color={theme.warning} bold>
        ⚠ Approval required ({approval.focusIndex + 1}/{approval.items.length})
      </Text>
      <Text color={theme.assistant} bold>
        {item.description}
      </Text>
      {item.command ? <Text color={theme.code}>{`$ ${clipLine(item.command, width)}`}</Text> : null}
      {item.diff ? (
        <Box flexDirection="column" marginLeft={1}>
          {shownDiff.map((l, i) => (
            <Text
              key={i}
              color={l.startsWith('+') ? theme.diffAdd : l.startsWith('-') ? theme.diffDel : l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++') ? theme.diffHunk : theme.muted}
            >
              {clipLine(l, width)}
            </Text>
          ))}
          {!diffExpanded && allDiff.length > 40 ? (
            <Text color={theme.muted}>
              … ({allDiff.length - 40} more lines — Ctrl+E to expand)
            </Text>
          ) : null}
        </Box>
      ) : null}
      {item.risk === 'high' ? <Text color={theme.error}>High-risk operation, please confirm carefully</Text> : null}
      <Text color={theme.muted} dimColor={!focused}>
        [y] allow [n] deny [a] always allow [d] always deny [e] feedback [A] allow all [D] deny all [Tab]/[←→] switch [x] abort
      </Text>
      {approval.feedbackMode ? (
        <Box>
          <Text color={theme.accent}>Feedback: </Text>
          <Text>{approval.feedbackText || '(type a revision, Enter to submit)'}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Batch approval dialog (the core interaction of Ask mode) */
export function ApprovalDialog({
  approval,
  width,
  callbacks,
  diffExpanded,
}: {
  approval: ApprovalView;
  width: number;
  callbacks: ApprovalCallbacks;
  diffExpanded: boolean;
}) {
  useInput((input, key) => {
    if (approval.feedbackMode) {
      if (key.return) callbacks.submitFeedback();
      else if (key.backspace || key.delete) callbacks.backspaceFeedback();
      else if (key.escape) callbacks.setFeedbackMode(false);
      else callbacks.typeFeedback(input);
      return;
    }
    if (key.tab) {
      callbacks.focusNext(1);
      return;
    }
    if (key.leftArrow) {
      callbacks.focusNext(-1);
      return;
    }
    if (key.rightArrow) {
      callbacks.focusNext(1);
      return;
    }
    if (key.ctrl && (input === 'e' || input === 'E')) {
      callbacks.toggleDiff();
      return;
    }
    const item = approval.items[approval.focusIndex];
    if (!item) return;
    if (input === 'y') callbacks.decide(item.callId, 'allow');
    else if (input === 'n') callbacks.decide(item.callId, 'deny');
    else if (input === 'a') callbacks.decide(item.callId, 'allow-always');
    else if (input === 'd') callbacks.decide(item.callId, 'deny-always');
    else if (input === 'A') callbacks.decideAll('allow');
    else if (input === 'D') callbacks.decideAll('deny');
    else if (input === 'e') callbacks.setFeedbackMode(true);
    else if (input === 'x') callbacks.abortAll();
    else if (/^[1-9]$/.test(input)) {
      // Quick selection of ask_user options
      const idx = Number(input) - 1;
      const opts = parseOptions(item.description);
      if (opts[idx]) callbacks.decide(item.callId, 'allow', opts[idx]);
    }
  });

  return (
    <Box borderStyle="bold" borderColor={theme.warning} paddingX={1} flexDirection="column" flexShrink={0}>
      {renderItem(approval, callbacks, width, diffExpanded)}
    </Box>
  );
}

function parseOptions(description: string): string[] {
  const m = /Options:\s*(.+)$/.exec(description);
  if (!m) return [];
  return m[1]!.split('|').map((s) => s.trim().replace(/^\d+\.\s*/, ''));
}
