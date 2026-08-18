import { describe, it, expect } from 'vitest';
import { parseMouse, WHEEL_UP, WHEEL_DOWN } from '../src/ui/mouse.js';

describe('parseMouse (SGR extended mouse sequences)', () => {
  it('parses a wheel-up press', () => {
    expect(parseMouse('[<64;12;34M')).toEqual({ button: 64, x: 12, y: 34, press: true });
  });

  it('parses a wheel-down press', () => {
    expect(parseMouse('[<65;5;9M')).toEqual({ button: 65, x: 5, y: 9, press: true });
  });

  it('parses the release (`m`) half and marks press=false', () => {
    expect(parseMouse('[<64;1;1m')).toEqual({ button: 64, x: 1, y: 1, press: false });
  });

  it('parses a left-click press (button 0)', () => {
    expect(parseMouse('[<0;20;7M')).toEqual({ button: 0, x: 20, y: 7, press: true });
  });

  it('returns null for non-mouse input', () => {
    expect(parseMouse('hello')).toBeNull();
    expect(parseMouse('[A')).toBeNull();
    expect(parseMouse('[200~')).toBeNull();
    expect(parseMouse('')).toBeNull();
  });

  it('exposes the xterm wheel button codes', () => {
    expect(WHEEL_UP).toBe(64);
    expect(WHEEL_DOWN).toBe(65);
  });
});
