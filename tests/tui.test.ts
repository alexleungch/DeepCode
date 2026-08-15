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
});

describe('markdown renderer', () => {
  it('headings/lists/code blocks/quotes are chunked', () => {
    const md = '# Title\n\n- item 1\n- item 2\n\n```ts\nconst a = 1;\n```\n\n> quote\n\nbody';
    const lines = renderMarkdown(md);
    expect(lines[0]).toEqual({ kind: 'h1', text: 'Title' });
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toContain('list');
    expect(kinds).toContain('code');
    expect(kinds).toContain('quote');
    expect(kinds).toContain('text');
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
