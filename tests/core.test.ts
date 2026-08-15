import { describe, it, expect } from 'vitest';
import { planBreakpoints } from '../src/caching/breakpoint-planner.js';
import type { ChatMessage } from '../src/providers/types.js';
import { compressMessages } from '../src/agent/compressor.js';
import { estimateTokens, estimateMessagesTokens } from '../src/agent/token-budget.js';
import { stableSort, toOpenAiTools, toAnthropicTools, toGeminiTools } from '../src/providers/tool-schema.js';
import type { ToolSchema } from '../src/providers/types.js';
import { cacheHitRate, cacheSavingsUsd, aggregateCacheHitRate } from '../src/caching/metrics.js';
import { estimateCostUsd } from '../src/usage/pricing.js';

const m = (role: 'user' | 'assistant', text: string): ChatMessage => ({ role, content: text });
const tr = (content: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: 't1', content }],
});

describe('breakpoint-planner', () => {
  it('always includes the system breakpoint (-1)', () => {
    const bps = planBreakpoints([m('user', 'hi')]);
    expect(bps[0]!.index).toBe(-1);
    expect(bps.length).toBeLessThanOrEqual(4);
  });

  it('marks the most recent tool_result message', () => {
    const msgs = [m('user', 'do it'), tr('ok'), m('user', 'again'), tr('done')];
    const bps = planBreakpoints(msgs);
    const idxs = bps.map((b) => b.index);
    expect(idxs).toContain(3);
  });

  it('at most 4 breakpoints', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? m('user', 'step') : tr('result')));
    const bps = planBreakpoints(msgs);
    expect(bps.length).toBeLessThanOrEqual(4);
  });

  it('returns empty when max=0', () => {
    expect(planBreakpoints([m('user', 'hi')], { max: 0 })).toEqual([]);
  });
});

describe('compressor', () => {
  const bigTurn = (i: number): ChatMessage[] => [
    m('user', `Task ${i}: implement module ${i}`),
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Analysis ${i}` },
        { type: 'tool_use', id: `c${i}`, name: 'read_file', input: { path: `f${i}.ts` } },
      ],
    },
    tr(`File content ${'x'.repeat(2000)} ${i}`),
  ];

  it('long sessions fold early turns and keep the recent ones', () => {
    let msgs: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) msgs = [...msgs, ...bigTurn(i)];
    msgs.push(m('user', 'wrap up'));
    const plan = compressMessages(msgs, {
      targetRatio: 0.6,
      keepRecentTurns: 3,
      maxSummaryTokens: 1500,
      maxToolResultChars: 8000,
    });
    expect(plan.removedTurns).toBeGreaterThan(0);
    expect(plan.tokensAfter).toBeLessThan(plan.tokensBefore);
    expect(plan.savedTokens).toBe(plan.tokensBefore - plan.tokensAfter);
    // summary exists
    expect(plan.summary).toContain('<summary>');
    expect(plan.summary).toContain('</summary>');
    // recent turns kept verbatim (last user message)
    const last = plan.messages[plan.messages.length - 1]!;
    expect(last).toEqual(m('user', 'wrap up'));
  });

  it('short sessions are not compacted', () => {
    const msgs = [...bigTurn(0), m('user', 'ok')];
    const plan = compressMessages(msgs, {
      targetRatio: 0.5,
      keepRecentTurns: 3,
      maxSummaryTokens: 1000,
      maxToolResultChars: 8000,
    });
    expect(plan.removedTurns).toBe(0);
    expect(plan.messages).toHaveLength(msgs.length);
  });

  it('clips oversized tool_result', () => {
    const msgs = [m('user', 'q'), tr('y'.repeat(20_000))];
    const plan = compressMessages(msgs, {
      targetRatio: 0.9,
      keepRecentTurns: 5,
      maxSummaryTokens: 1000,
      maxToolResultChars: 500,
    });
    const kept = plan.messages.find((x) => typeof x.content !== 'string');
    expect(kept).toBeDefined();
    const blocks = kept!.content as ChatMessage['content'];
    const trBlock = blocks.find((b) => b.type === 'tool_result');
    expect((trBlock as { content: string }).content.length).toBeLessThan(2000);
    expect((trBlock as { content: string }).content).toContain('truncated');
  });

  it('extractFacts integration: facts from compacted turns enter memory extraction', () => {
    let msgs: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) msgs = [...msgs, ...bigTurn(i)];
    msgs.push(m('user', 'done'));
    const plan = compressMessages(msgs, {
      targetRatio: 0.6,
      keepRecentTurns: 2,
      maxSummaryTokens: 1000,
      maxToolResultChars: 8000,
      extractFacts: (turns) =>
        turns.length > 0 ? [{ type: 'fact', content: `${turns.length} messages before compaction` }] : [],
    });
    expect(plan.movedToMemory.length).toBeGreaterThan(0);
  });
});

describe('token-budget', () => {
  it('estimateTokens basic behavior', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('')).toBe(0);
  });
  it('estimateMessagesTokens totals', () => {
    const msgs = [m('user', 'a'.repeat(700)), m('assistant', 'b'.repeat(700))];
    expect(estimateMessagesTokens(msgs)).toBeGreaterThan(100);
  });
});

describe('tool-schema', () => {
  const tools: ToolSchema[] = [
    { name: 'b_tool', description: 'desc', inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } } },
    { name: 'a_tool', description: 'desc2', inputSchema: { type: 'object', properties: { b: { type: 'string' } } } },
  ];

  it('stableSort sorts by key name (byte-stable)', () => {
    const sorted = stableSort({ b: 1, a: { d: 2, c: 3 }, arr: [3, 1, 2] }) as Record<string, unknown>;
    expect(Object.keys(sorted)).toEqual(['a', 'arr', 'b']);
    expect(Object.keys(sorted.a as Record<string, unknown>)).toEqual(['c', 'd']);
  });

  it('OpenAI format keeps registration order', () => {
    const out = toOpenAiTools(tools);
    expect(out.map((t) => t.function.name)).toEqual(['b_tool', 'a_tool']);
  });

  it('Anthropic format', () => {
    const out = toAnthropicTools(tools);
    expect(out[0]!.name).toBe('b_tool');
    expect(out[0]!.input_schema).toBeDefined();
  });

  it('Gemini format', () => {
    const out = toGeminiTools(tools);
    expect(out[0]!.functionDeclarations.map((f) => f.name)).toEqual(['b_tool', 'a_tool']);
  });
});

describe('caching/metrics + pricing', () => {
  it('cacheHitRate', () => {
    expect(cacheHitRate({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 300 })).toBe(0.3);
    expect(cacheHitRate({ inputTokens: 1000, outputTokens: 0 })).toBeNull();
  });

  it('aggregateCacheHitRate aggregates', () => {
    const items = [
      { inputTokens: 1000, cacheReadTokens: 200 },
      { inputTokens: 1000, promptCacheHitTokens: 400 },
    ];
    expect(aggregateCacheHitRate(items)).toBeCloseTo(0.3);
  });

  it('estimateCostUsd distinguishes cache hits', () => {
    const price = { input: 3, output: 15, cacheRead: 0.3 };
    const withCache = estimateCostUsd(price, { inputTokens: 100_000, outputTokens: 1000, cacheReadTokens: 80_000 });
    const noCache = estimateCostUsd(price, { inputTokens: 100_000, outputTokens: 1000 });
    expect(noCache).toBeGreaterThan(withCache);
    // 80k*0.3 + 20k*3 + 1k*15 = 24k + 60k + 15k = 99000 / 1e6 = 0.099
    expect(withCache).toBeCloseTo(0.099, 6);
  });

  it('cacheSavingsUsd', () => {
    const price = { input: 3, output: 15, cacheRead: 0.3 };
    expect(cacheSavingsUsd(price, { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 80_000 })).toBeCloseTo(0.216);
  });
});
