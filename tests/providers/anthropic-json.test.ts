import { describe, it, expect } from 'vitest';
import { appendToolJson, parseToolInput } from '../../src/providers/anthropic.js';

describe('Anthropic streaming tool-input accumulation (partial_json concatenation)', () => {
  it('concatenates fragments and parses the result at the end', () => {
    let raw = '';
    for (const fragment of ['{"path"', ':"a.ts","li', 'nes":3}']) {
      raw = appendToolJson(raw, fragment);
    }
    expect(parseToolInput(raw)).toEqual({ path: 'a.ts', lines: 3 });
  });

  it('falls back to a _raw marker when the stream cut off mid-JSON', () => {
    const raw = appendToolJson('', '{"path":');
    expect(parseToolInput(raw)).toEqual({ _raw: '{"path":' });
  });

  it('treats an empty buffer as empty input', () => {
    expect(parseToolInput('')).toEqual({});
  });

  it('does not parse a lone fragment as if it were complete JSON', () => {
    // The regression this guards against: the old code JSON.parsed each fragment in isolation.
    const raw = appendToolJson('', '{"path"');
    expect(parseToolInput(raw)).toEqual({ _raw: '{"path"' });
  });
});
