import { describe, it, expect } from 'vitest';
import { osc11ToHex } from '../src/ui/background.js';

describe('osc11ToHex (terminal background color response parsing)', () => {
  it('parses the 16-bit rgb: form (iTerm2/kitty/xterm style)', () => {
    expect(osc11ToHex('\x1b]11;rgb:ffff/ffff/ffff\x07')).toBe('#ffffff');
    expect(osc11ToHex('\x1b]11;rgb:0000/0000/0000\x07')).toBe('#000000');
    expect(osc11ToHex('\x1b]11;rgb:1a1a/2b2b/3c3c\x07')).toBe('#1a2b3c');
  });

  it('parses the 24-bit rgb: form (6 hex digits per channel)', () => {
    expect(osc11ToHex('\x1b]11;rgb:ffffff/ffffff/ffffff\x07')).toBe('#ffffff');
    // Each channel's TOP byte becomes the #RRGGBB pair: 1a2b3c → 1a, 4d5e6f → 4d, 0a0b0c → 0a.
    expect(osc11ToHex('\x1b]11;rgb:1a2b3c/4d5e6f/0a0b0c\x1b\\')).toBe('#1a4d0a');
  });

  it('parses the plain #RRGGBB form used by some terminals', () => {
    expect(osc11ToHex('\x1b]11;#ffffff\x07')).toBe('#ffffff');
    expect(osc11ToHex('\x1b]11;#0A0B0C\x07')).toBe('#0a0b0c');
    expect(osc11ToHex('rgb:ffff/ffff/ffff\x07')).toBe('#ffffff');
  });

  it('returns undefined for garbage / no response', () => {
    expect(osc11ToHex('')).toBeUndefined();
    expect(osc11ToHex('\x1b]11;?\x07')).toBeUndefined();
    expect(osc11ToHex('hello world')).toBeUndefined();
  });
});
