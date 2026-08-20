import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { parseMouse } from '../mouse.js';
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
  // ask_user questions carry "Options: 1. … | 2. …" on the description; render them as a
  // numbered list (press 1-9 to answer) instead of a single cluttered line.
  const options = parseOptions(item.description);
  const cleanDesc = options.length > 0 ? item.description.replace(/\nOptions:.*$/, '') : (item.description || '(no description)');
  return (
    <Box flexDirection="column">
      <Text color={theme.warning} bold>
        ⚠ Approval required ({approval.focusIndex + 1}/{approval.items.length})
      </Text>
      <Text color={theme.assistant} bold>
        {cleanDesc}
      </Text>
      {options.length > 0 ? (
        <Box flexDirection="column" marginLeft={1}>
          {options.map((o, i) => (
            <Text key={i} color={theme.accent}>
              <Text color={theme.primary} bold>{i + 1})</Text> {o}
            </Text>
          ))}
        </Box>
      ) : null}
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
      {item.risk === 'high' ? (
        <Text color={theme.error} bold>
          ⛔ High-risk operation — please confirm carefully
        </Text>
      ) : item.risk === 'medium' ? (
        <Text color={theme.warning}>
          ⚡ Medium-risk operation — review before approving
        </Text>
      ) : null}
      {options.length > 0 ? (
        <Text color={theme.muted} dimColor={!focused}>
          [1-9] pick option · [y] yes · [n] no · [e] custom answer · [x] abort
        </Text>
      ) : (
        <Text color={theme.muted} dimColor={!focused}>
          [y] allow [n] deny [a] always [d] always deny [e] feedback [A] allow all [D] deny all [Tab]/[←→] switch [x] abort
        </Text>
      )}
      {approval.feedbackMode ? (
        <Box>
          <Text color={theme.accent}>{options.length > 0 ? 'Answer: ' : 'Feedback: '}</Text>
          <Text>{approval.feedbackText || (options.length > 0 ? '(type your answer, Enter to submit)' : '(type a revision, Enter to submit)')}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Batch approval dialog (the core interaction of Ask mode).
 *
 * Improvements:
 *  - Risk warnings are more prominent with icon prefix
 *  - Option numbers are color-coded for better visibility
 *  - Better keyboard shortcut hints in the help line
 *  - Empty descriptions show "(no description)" instead of blank
 */
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
    // Ignore SGR mouse events so wheel/clicks never register as decisions or feedback text.
    if (parseMouse(input)) return;
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
