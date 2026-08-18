import { describe, it, expect } from 'vitest';
import { emptyState, reduceState, addUserMessage, setContextInfo } from '../src/ui/state.js';
import { renderMarkdown, markdownToPlain } from '../src/ui/markdown.js';
import { friendlySummary } from '../src/ui/components/ToolCard.js';
import type { ToolCallView } from '../src/ui/state.js';
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

  it('todo-updated drives the live todo panel state', () => {
    let s = emptyState();
    expect(s.todos).toEqual([]);
    s = reduceState(s, {
      type: 'todo-updated',
      todos: [
        { content: 'scan the repo', status: 'completed' },
        { content: 'write the report', status: 'in_progress' },
        { content: 'send it', status: 'pending' },
      ],
    });
    expect(s.todos).toHaveLength(3);
    expect(s.todos[1]).toMatchObject({ content: 'write the report', status: 'in_progress' });
    // A later full replacement (todo_write semantics) replaces, not appends
    s = reduceState(s, { type: 'todo-updated', todos: [{ content: 'done', status: 'completed' }] });
    expect(s.todos).toHaveLength(1);
    expect(s.todos[0]!.status).toBe('completed');
  });

  it('mode notices (plan-mode banner) are cleared by the next turn so they do not stay pinned', () => {
    let s = emptyState();
    s.notices = [{ id: 1, text: 'Plan mode on — the agent only reads and proposes a plan; write/exec tools are denied.', kind: 'info', group: 'mode' }];
    expect(s.notices).toHaveLength(1);
    // The verbose banner must not linger at the bottom of the live region once a new turn starts;
    // the persistent [PLAN] badge in the status bar is the always-visible indicator.
    s = reduceState(s, { type: 'turn-start', turn: 1 });
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

  it('tables tolerate rows missing the leading/trailing pipe', () => {
    const md = '| 维度 | Pi |\n|---|----|\n 定位 | 开箱即用\n| 模型 | deepseek |';
    const lines = renderMarkdown(md);
    const texts = lines.map((l) => l.text);
    // all four rows (top border, header, separator, 2 data rows, bottom border) present
    expect(texts).toHaveLength(6);
    expect(texts[0]).toContain('┌');
    expect(texts.join('\n')).toContain('开箱即用');
    expect(texts.join('\n')).toContain('deepseek');
  });

  it('tables align CJK cells by display width (not code units)', () => {
    const lines = renderMarkdown('| 维度 | Pi |\n|---|----|\n| 模型 | deepseek |');
    const texts = lines.map((l) => l.text);
    // header row and data row must render with same column widths
    const cellStart = texts[1]!.indexOf('Pi');
    const dataStart = texts[3]!.indexOf('deepseek');
    expect(cellStart).toBeGreaterThan(-1);
    expect(dataStart).toBe(cellStart);
    // every row has the same total width so the right border lines up
    const widths = texts.filter((t) => t.startsWith('│')).map((t) => t.length);
    expect(new Set(widths).size).toBe(1);
  });

  it('tables keep escaped pipes inside a cell', () => {
    const lines = renderMarkdown('| a \\| b | c |\n|---|---|\n| x | y |');
    const texts = lines.map((l) => l.text);
    expect(texts.join('\n')).toContain('a | b');
  });

  it('plain paragraphs containing a single pipe are not treated as tables', () => {
    const lines = renderMarkdown('foo | bar');
    const texts = lines.map((l) => l.text);
    expect(texts[0]).toBe('foo | bar');
    expect(texts.some((t) => t.includes('┌'))).toBe(false);
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

describe('tool card friendly summary', () => {
  const card = (over: Partial<ToolCallView>): ToolCallView => ({
    callId: 'c1',
    name: 'read_file',
    input: {},
    inputJson: '',
    progress: '',
    status: 'streaming',
    ...over,
  });

  it('read_file → path (+lines after completion)', () => {
    const running = card({ name: 'read_file', input: { path: 'src/foo.ts' } });
    expect(friendlySummary(running)).toBe('src/foo.ts');
    const done = card({
      name: 'read_file',
      input: { path: 'src/foo.ts' },
      status: 'done',
      result: { content: '📄 src/foo.ts (120 lines total)\n     1 | x' },
    });
    expect(friendlySummary(done)).toBe('src/foo.ts (+120 lines)');
  });

  it('edit_file → path with ++a/−d diff stats', () => {
    const done = card({
      name: 'edit_file',
      input: { path: 'src/bar.ts' },
      status: 'done',
      result: {
        content: 'Wrote src/bar.ts',
        diff: '--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+another',
      },
    });
    expect(friendlySummary(done)).toBe('src/bar.ts (++2 −1)');
  });

  it('run_terminal_cmd → the command; glob/grep → the pattern', () => {
    expect(friendlySummary(card({ name: 'run_terminal_cmd', input: { command: 'npm test -- --watch' } }))).toBe('npm test -- --watch');
    expect(friendlySummary(card({ name: 'glob', input: { pattern: '**/*.ts' } }))).toBe('**/*.ts');
    expect(friendlySummary(card({ name: 'grep', input: { pattern: 'TODO\\(' } }))).toBe('TODO\\(');
  });

  it('task → label (falls back to the task text)', () => {
    expect(friendlySummary(card({ name: 'task', input: { label: 'write tests', task: 'long task text' } }))).toBe('write tests');
    expect(friendlySummary(card({ name: 'task', input: { task: 'long task text' } }))).toBe('long task text');
  });

  it('streaming partial JSON is parsed best-effort (fallback …)', () => {
    // Partial object: the committed pair is used.
    expect(friendlySummary(card({ name: 'read_file', inputJson: '{"path":"src/foo' }))).toBe('src/foo');
    // Complete streamed JSON overrides the one-shot input.
    expect(friendlySummary(card({ name: 'read_file', inputJson: '{"path":"src/foo.ts"}' }))).toBe('src/foo.ts');
    // Garbage → no args at all → "…"
    expect(friendlySummary(card({ name: 'read_file', inputJson: '{"' }))).toBe('…');
    expect(friendlySummary(card({ name: 'todo_write' }))).toBe('…');
  });

  it('unknown tools fall back to the first string arg', () => {
    expect(friendlySummary(card({ name: 'skill', input: { name: 'my-skill' } }))).toBe('my-skill');
  });
});
