import { describe, it, expect } from 'vitest';
import { emptyState, reduceState, addUserMessage, setContextInfo } from '../src/ui/state.js';
import { renderMarkdown, markdownToPlain } from '../src/ui/markdown.js';
import type { EngineEvent } from '../src/events.js';

describe('TUI state reducer', () => {
  it('text-delta accumulates into the streaming assistant message', () => {
    let s = emptyState();
    s = reduceState(s, { type: 'turn-start', turn: 1 });
    s = reduceState(s, { type: 'text-delta', text: 'Hello ' });
    s = reduceState(s, { type: 'text-delta', text: 'world' });
    const m = s.messages[0]!;
    expect(m.role).toBe('assistant');
    expect(m.text).toBe('Hello world');
    expect(m.streaming).toBe(true);
    expect(s.busy).toBe(true);
  });

  it('message event finalizes the streaming message', () => {
    let s = emptyState();
    s = reduceState(s, { type: 'text-delta', text: 'a' });
    s = reduceState(s, { type: 'message', message: { role: 'assistant', content: 'final content' }, source: 'assistant' });
    expect(s.messages[0]!.text).toBe('final content');
    expect(s.messages[0]!.streaming).toBe(false);
  });

  it('message event with tool_use blocks materializes cards (one-shot done, no streamed tool-start)', () => {
    // A provider that returns tool_use only in the final message (no streaming tool-start):
    // the card must exist on the same assistant message so the executor's tool-start (same
    // callId) dedupes in place and the message can settle after tool-result.
    let s = emptyState();
    s = reduceState(s, { type: 'text-delta', text: 'Reading' });
    s = reduceState(s, {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      source: 'assistant',
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.toolCalls).toHaveLength(1);
    expect(s.messages[0]!.toolCalls[0]!).toMatchObject({ callId: 'c1', name: 'read_file', input: { path: 'a.ts' }, status: 'streaming' });
    // The executor re-emits tool-start with the same callId: dedupe in place, no new message.
    s = reduceState(s, { type: 'tool-start', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.toolCalls).toHaveLength(1);
    s = reduceState(s, { type: 'tool-result', callId: 'c1', name: 'read_file', result: { content: 'ok' }, durationMs: 5 });
    expect(s.messages[0]!.toolCalls[0]!.status).toBe('done');
    // settled semantics: not streaming and all cards terminal
    expect(s.messages[0]!.streaming).toBe(false);
  });

  it('streamed card gets its input filled in from the final message block (no duplicate card)', () => {
    let s = emptyState();
    s = reduceState(s, { type: 'text-delta', text: 'x' });
    // Streaming tool-start carries input: {} (args arrive as deltas)
    s = reduceState(s, { type: 'tool-start', callId: 'c1', name: 'read_file', input: {} });
    s = reduceState(s, { type: 'tool-input-delta', callId: 'c1', partialJson: '{"path":"a.ts"}' });
    // The final message block carries the full input: merge, don't duplicate.
    s = reduceState(s, {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } }] },
      source: 'assistant',
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.toolCalls).toHaveLength(1);
    expect(s.messages[0]!.toolCalls[0]!.input).toEqual({ path: 'a.ts' });
  });

  it('context event updates the status-bar context ratio (not frozen at startup)', () => {
    let s = emptyState();
    expect(s.contextRatio).toBe(0);
    s = reduceState(s, { type: 'context', ratio: 0.42, window: 64_000 });
    expect(s.contextRatio).toBe(0.42);
    expect(s.contextWindow).toBe(64_000);
    s = reduceState(s, { type: 'context', ratio: 0.5, window: 64_000 });
    expect(s.contextRatio).toBe(0.5);
  });

  it('tool-start/input-delta/result drive the tool card', () => {
    let s = emptyState();
    s = reduceState(s, { type: 'text-delta', text: 'x' });
    s = reduceState(s, { type: 'tool-start', callId: 'c1', name: 'read_file', input: {} });
    s = reduceState(s, { type: 'tool-input-delta', callId: 'c1', partialJson: '{"path"' });
    s = reduceState(s, { type: 'tool-input-delta', callId: 'c1', partialJson: ': "a.ts"}' });
    const tc = s.messages[0]!.toolCalls[0]!;
    expect(tc.name).toBe('read_file');
    expect(tc.inputJson).toBe('{"path": "a.ts"}');
    expect(tc.status).toBe('streaming');
    s = reduceState(s, { type: 'tool-result', callId: 'c1', name: 'read_file', result: { content: 'ok' }, durationMs: 5 });
    expect(s.messages[0]!.toolCalls[0]!.status).toBe('done');
    expect(s.messages[0]!.toolCalls[0]!.durationMs).toBe(5);
  });

  it('usage events accumulate totals (partial ignored)', () => {
    let s = emptyState();
    const base = { ts: 1, sessionId: 's', provider: 'deepseek' as const, model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
    s = reduceState(s, { type: 'usage', usage: { ...base, inputTokens: 500, outputTokens: 100, costUsd: 0.01, partial: true } });
    expect(s.usage.inputTokens).toBe(0); // partial is not booked
    s = reduceState(s, { type: 'usage', usage: { ...base, inputTokens: 500, outputTokens: 100, cacheReadTokens: 200, costUsd: 0.01 } });
    expect(s.usage.inputTokens).toBe(500);
    expect(s.usage.cacheReadTokens).toBe(200);
    expect(s.usage.costUsd).toBeCloseTo(0.01);
  });

  it('approval-request enters the approval state', () => {
    let s = emptyState();
    s = reduceState(s, {
      type: 'approval-request',
      requestId: 'r1',
      items: [{ callId: 'c1', toolName: 'bash', description: 'npm test', risk: 'medium' }],
    });
    expect(s.approvals).toHaveLength(1);
    expect(s.busy).toBe(false);
  });

  it('approval-result restores busy so the input stays locked while tools execute', () => {
    let s = emptyState();
    s = reduceState(s, { type: 'turn-start', turn: 1 });
    s = reduceState(s, {
      type: 'approval-request',
      requestId: 'r1',
      items: [{ callId: 'c1', toolName: 'bash', description: 'npm test', risk: 'medium' }],
    });
    expect(s.busy).toBe(false); // dialog takes over the input area
    s = reduceState(s, { type: 'approval-result', requestId: 'r1', decisions: [{ callId: 'c1', action: 'allow' }] });
    expect(s.busy).toBe(true); // turn still running (tools execute next) — input must stay locked
    expect(s.approvals[0]!.resolved).toBe(true);
    s = reduceState(s, { type: 'turn-end', turn: 1, stopReason: 'end_turn' });
    expect(s.busy).toBe(false);
  });

  it('compacted event notice + record', () => {
    let s = emptyState();
    s = reduceState(s, {
      type: 'compacted',
      plan: {
        messages: [],
        summary: 's',
        removedTurns: 3,
        tokensBefore: 1000,
        tokensAfter: 400,
        savedTokens: 600,
        keptRecentTurns: 5,
        movedToMemory: [],
      },
    });
    expect(s.lastCompaction?.savedTokens).toBe(600);
    expect(s.notices.some((n) => n.text.includes('Context compacted'))).toBe(true);
  });

  it('addUserMessage appends a user message', () => {
    const s = addUserMessage(emptyState(), 'hello');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.role).toBe('user');
  });

  it('interrupted/error notices are transient: replaced by same-group and dropped on turn-start', () => {
    let s = emptyState();
    s = reduceState(s, { type: 'interrupted' });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]!.text).toBe('Interrupted');
    // A second transient status replaces the first instead of stacking
    s = reduceState(s, { type: 'error', message: 'boom' });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]!.text).toBe('Error: boom');
    // A new turn clears the stale status notice so it no longer occupies the live region
    s = reduceState(s, { type: 'turn-start', turn: 2 });
    expect(s.notices).toHaveLength(0);
  });
});

describe('markdown renderer', () => {
  it('headings/lists/code blocks/quotes are chunked', () => {
    const md = '# Title\n\n- item 1\n- item 2\n\n```ts\nconst a = 1;\n```\n\n> quote\n\nbody';
    const lines = renderMarkdown(md);
    expect(lines[0]).toMatchObject({ kind: 'h1', text: 'Title' });
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toContain('list');
    expect(kinds).toContain('code');
    expect(kinds).toContain('quote');
    expect(kinds).toContain('text');
  });

  it('inline styles become per-run segments (bold/italic/code/link)', () => {
    const [line] = renderMarkdown('see **bold** and `code` and [docs](https://x.com)');
    expect(line).toMatchObject({ kind: 'text', text: 'see bold and code and docs' });
    expect(line.segments).toEqual([
      { text: 'see ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'code', code: true },
      { text: ' and ' },
      { text: 'docs', link: true },
    ]);
  });

  it('task lists render ☐/☑ markers', () => {
    const lines = renderMarkdown('- [ ] todo\n- [x] done');
    expect(lines[0]).toMatchObject({ kind: 'list', task: true, checked: false, text: '☐ todo' });
    expect(lines[1]).toMatchObject({ kind: 'list', task: true, checked: true, text: '☑ done' });
  });

  it('tables are aligned with box-drawing borders', () => {
    const lines = renderMarkdown('| a | bb |\n|---|----|\n| 1 | 22 |');
    const texts = lines.map((l) => l.text);
    expect(texts[0]).toContain('┌');
    expect(texts[1]).toContain('a');
    expect(texts[1]).toContain('bb');
    expect(texts[texts.length - 1]).toContain('└');
  });

  it('markdownToPlain round-trips', () => {
    const plain = markdownToPlain('# T\n\n```js\nx\n```\n\n- a');
    expect(plain).toContain('# T');
    expect(plain).toContain('```');
    expect(plain).toContain('• a');
  });

  it('link syntax is stripped', () => {
    const lines = renderMarkdown('see [docs](https://x.com)');
    expect(lines[0]!.text).toBe('see docs');
  });
});
