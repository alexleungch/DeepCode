import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { DeepcodeEngine } from '../src/engine.js';
import { theme } from '../src/ui/theme.js';
import {
  applyTheme,
  resolveTheme,
  isThemeId,
  setActiveThemeId,
  currentThemeId,
  themeListing,
  THEMES,
  contrastRatio,
  luminance,
} from '../src/ui/themes.js';
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '../src/providers/types.js';

const silentProvider = (): LLMProvider => ({
  id: 'deepseek',
  model: 'deepseek-chat',
  modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: false, supportsTools: true, cacheControl: 'auto' },
  async *stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    return;
  },
  async complete() {
    throw new Error('not used');
  },
});

let home: string;
let ws: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'theme-home-'));
  ws = mkdtempSync(join(tmpdir(), 'theme-ws-'));
  prevHome = process.env.DEEPCODE_HOME;
  process.env.DEEPCODE_HOME = home;
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

describe('theme registry (themes.ts)', () => {
  it('lists every built-in theme with an id', () => {
    const listing = themeListing();
    expect(listing.length).toBe(Object.keys(THEMES).length);
    for (const line of listing) expect(line).toMatch(/^\s{2}\S+\s+.+ — .+\[(light|dark)\]$/);
  });

  it('isThemeId / resolveTheme: known ids resolve, unknown fall back to default', () => {
    expect(isThemeId('dracula')).toBe(true);
    expect(isThemeId('nope')).toBe(false);
    expect(resolveTheme('dracula').id).toBe('dracula');
    expect(resolveTheme('nope').id).toBe('default');
    expect(resolveTheme(undefined).id).toBe('default');
  });

  it('applyTheme returns the palette without mutating the active id', () => {
    const before = currentThemeId();
    const pal = applyTheme('matrix');
    expect(pal.primary).toBe('#00ff41');
    expect(currentThemeId()).toBe(before);
  });
});

describe('light themes (readability on a white terminal background)', () => {
  const lightThemes = Object.values(THEMES).filter((t) => t.mode === 'light');
  const darkThemes = Object.values(THEMES).filter((t) => t.mode === 'dark');

  it('ships at least two light themes and marks every theme with a mode', () => {
    expect(isThemeId('light')).toBe(true);
    expect(isThemeId('gruvbox-light')).toBe(true);
    expect(lightThemes.length).toBeGreaterThanOrEqual(2);
    for (const t of Object.values(THEMES)) expect(['light', 'dark']).toContain(t.mode);
  });

  it('themeListing exposes the background mode of each theme', () => {
    for (const line of themeListing()) {
      expect(line).toMatch(/\[(light|dark)\]$/);
    }
  });

  it('light themes use dark text on the light background (WCAG AA body contrast)', () => {
    for (const t of lightThemes) {
      // Body/assistant text must be dark and pass 4.5:1 against white.
      expect(luminance(t.assistant), `${t.id}: assistant dark enough`).toBeLessThan(0.5);
      expect(contrastRatio(t.assistant, '#ffffff'), `${t.id}: assistant contrast`).toBeGreaterThanOrEqual(4.5);
      // Code text must be dark against the light code block background too.
      expect(contrastRatio(t.code, t.codeBg), `${t.id}: code contrast on codeBg`).toBeGreaterThanOrEqual(4.5);
      // Semantic accents stay readable on white.
      for (const slot of ['primary', 'success', 'error', 'warning', 'user', 'accent'] as const) {
        expect(contrastRatio(t[slot], '#ffffff'), `${t.id}: ${slot} on white`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('dark themes use bright text on near-black', () => {
    for (const t of darkThemes) {
      expect(luminance(t.assistant), `${t.id}: assistant bright`).toBeGreaterThan(0.6);
      expect(contrastRatio(t.assistant, '#000000'), `${t.id}: assistant on black`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('switches to a light theme through setActiveThemeId + applyTheme', () => {
    setActiveThemeId('light');
    applyTheme(currentThemeId());
    expect(theme.mode).toBe('light');
    expect(theme.assistant).toBe('#1f2328');
    // restore for other tests
    setActiveThemeId('default');
    applyTheme(currentThemeId());
  });
});

describe('theme singleton (theme.ts)', () => {
  it('switches to the new palette after setActiveThemeId + applyTheme', () => {
    setActiveThemeId('dracula');
    applyTheme(currentThemeId());
    expect(theme.primary).toBe('#bd93f9');
    // restore for other tests
    setActiveThemeId('default');
    applyTheme(currentThemeId());
    expect(theme.primary).toBe('#4f9cf9');
  });
});

describe('engine.setTheme', () => {
  async function setup() {
    const resolved = loadConfig({ workspace: ws });
    resolved.config.providers.deepseek = { apiKey: 'k', baseUrl: 'http://fake' };
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = silentProvider() as never;
    await engine.init();
    return { engine, resolved };
  }

  it('switches the runtime palette and the live config', async () => {
    const { engine } = await setup();
    engine.setTheme('nord');
    expect(theme.primary).toBe('#88c0d0');
    expect(engine.config.ui?.theme).toBe('nord');
    engine.close();
  });

  it('unknown themes fall back to default (no throw)', async () => {
    const { engine } = await setup();
    engine.setTheme('bogus');
    expect(engine.config.ui?.theme).toBe('default');
    expect(theme.primary).toBe('#4f9cf9');
    engine.close();
  });

  it('persists the theme id to ~/.deepcode/config.json', async () => {
    const { engine } = await setup();
    engine.setTheme('solarized', true);
    const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { ui?: { theme?: string } };
    expect(saved.ui?.theme).toBe('solarized');
    engine.close();
  });

  it('configured ui.theme is loaded and applied on the next startup', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ ui: { theme: 'matrix' }, providers: { deepseek: { apiKey: 'k', baseUrl: 'http://fake' } } }),
      'utf8',
    );
    const resolved = loadConfig({ workspace: ws });
    expect(resolved.config.ui?.theme).toBe('matrix');
    const engine = new DeepcodeEngine({ resolved });
    engine.provider = silentProvider() as never;
    setActiveThemeId(resolved.config.ui?.theme);
    applyTheme(currentThemeId());
    expect(theme.primary).toBe('#00ff41');
    engine.close();
  });
});