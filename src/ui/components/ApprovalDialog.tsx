import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import type { ApprovalView } from '../state.js';
import { clipLine } from '../markdown.js';

export interface ApprovalCallbacks {
  /** y/n/a/d or an option number */
  decide(itemCallId: string, action: 'allow' | 'deny' | 'allow-always' | 'deny-always', feedback?: string): void;
  /** Attach feedback (e mode) */
  setFeedbackMode(on: boolean): void;
  /** Incremental feedback text */
  typeFeedback(ch: string): void;
  backspaceFeedback(): void;
  submitFeedback(): void;
  /** Deny everything and abort */
  abortAll(): void;
  focusNext(delta: number): void;
}

function renderItem(approval: ApprovalView, callbacks: ApprovalCallbacks, width: number) {
  const item = approval.items[approval.focusIndex];
  if (!item) return null;
  const focused = !approval.feedbackMode;
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
          {item.diff.split('\n').slice(0, 40).map((l, i) => (
            <Text
              key={i}
              color={l.startsWith('+') ? theme.diffAdd : l.startsWith('-') ? theme.diffDel : l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++') ? theme.diffHunk : theme.muted}
            >
              {clipLine(l, width)}
            </Text>
          ))}
        </Box>
      ) : null}
      {item.risk === 'high' ? <Text color={theme.error}>High-risk operation, please confirm carefully</Text> : null}
      <Text color={theme.muted} dimColor={!focused}>
        [y] allow [n] deny [a] always allow [d] always deny [e] add feedback [Tab] switch item
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
export function ApprovalDialog({ approval, width, callbacks }: { approval: ApprovalView; width: number; callbacks: ApprovalCallbacks }) {
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
    const item = approval.items[approval.focusIndex];
    if (!item) return;
    if (input === 'y') callbacks.decide(item.callId, 'allow');
    else if (input === 'n') callbacks.decide(item.callId, 'deny');
    else if (input === 'a') callbacks.decide(item.callId, 'allow-always');
    else if (input === 'd') callbacks.decide(item.callId, 'deny-always');
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
      {renderItem(approval, callbacks, width)}
    </Box>
  );
}

function parseOptions(description: string): string[] {
  const m = /Options:\s*(.+)$/.exec(description);
  if (!m) return [];
  return m[1]!.split('|').map((s) => s.trim().replace(/^\d+\.\s*/, ''));
}
