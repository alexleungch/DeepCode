import { describe, it, expect } from 'vitest';
import { classifyMessage, isAllowed } from '../../src/telegram/routing.js';

describe('classifyMessage', () => {
  it('recognizes slash commands case-insensitively', () => {
    expect(classifyMessage('/start')).toEqual({ kind: 'help' });
    expect(classifyMessage('/help')).toEqual({ kind: 'help' });
    expect(classifyMessage('/NEW')).toEqual({ kind: 'new' });
    expect(classifyMessage('/status')).toEqual({ kind: 'status' });
  });

  it('treats anything else as an instruction', () => {
    expect(classifyMessage('  list files  ')).toEqual({ kind: 'instruction', text: 'list files' });
    expect(classifyMessage('/unknown')).toEqual({ kind: 'instruction', text: '/unknown' });
  });
});

describe('isAllowed', () => {
  it('denies everyone when the allowlist is empty', () => {
    expect(isAllowed(1, [])).toBe(false);
  });

  it('allows matching ids and denies others', () => {
    expect(isAllowed(42, [42, 7])).toBe(true);
    expect(isAllowed(1, [42, 7])).toBe(false);
  });
});
