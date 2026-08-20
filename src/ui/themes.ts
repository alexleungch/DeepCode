/**
 * TUI theme registry.
 *
 * Each theme maps every semantic UI slot to a terminal color (hex / ANSI name).
 * Themes are selectable:
 *   - config:  ui.theme = "<id>"  (default)
 *   - CLI:     deepcode --theme <id>
 *   - runtime: /theme [id]        inside the TUI
 *
 * Every theme declares a `mode` ('light' | 'dark'). When NO theme is configured
 * explicitly, the TUI probes the terminal background color at startup and
 * automatically picks a light theme on light backgrounds (see
 * src/ui/background.ts), so Mac-default white terminals never show unreadable
 * near-white text.
 *
 * Colors are chosen for 256-color terminals; Ink accepts hex strings and
 * named ANSI colors. Light-theme text colors are dark enough to pass WCAG AA
 * contrast on a white background; dark-theme text is bright on near-black.
 */

export type ThemeColors = {
  /** Background this palette is designed for (light terminals use dark text) */
  mode: 'light' | 'dark';
  primary: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  user: string;
  assistant: string;
  code: string;
  /** Background of code blocks (every built-in theme sets this) */
  codeBg: string;
  diffAdd: string;
  diffDel: string;
  diffHunk: string;
  thinking: string;
  accent: string;
  // Tool-card family colors (Claude-Code-style per-category tinting)
  toolRead: string;
  toolEdit: string;
  toolExec: string;
  toolSearch: string;
  toolOther: string;
};

export interface ThemeDef extends ThemeColors {
  id: string;
  name: string;
  /** Short human description shown in `/theme` */
  description: string;
  /** Terminal background this palette is designed for (drives auto-selection) */
  mode: 'light' | 'dark';
}

export const THEME_IDS = [
  'default',
  'dracula',
  'gruvbox',
  'nord',
  'solarized',
  'matrix',
  'light',
  'gruvbox-light',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const THEMES: Record<ThemeId, ThemeDef> = {
  // GitHub-dark-inspired baseline (the original palette)
  default: {
    id: 'default',
    name: 'Default',
    description: 'GitHub-dark inspired baseline',
    mode: 'dark',
    primary: '#4f9cf9',
    success: '#3fb950',
    error: '#f85149',
    warning: '#d29922',
    muted: '#8b949e',
    user: '#58a6ff',
    assistant: '#e6edf3',
    code: '#c9d1d9',
    codeBg: '#161b22',
    diffAdd: '#3fb950',
    diffDel: '#f85149',
    diffHunk: '#58a6ff',
    thinking: '#6e7681',
    accent: '#bc8cff',
    toolRead: '#79c0ff',
    toolEdit: '#bc8cff',
    toolExec: '#d29922',
    toolSearch: '#8b949e',
    toolOther: '#8b949e',
  },
  // Dracula — high-contrast, purple-pink leaning
  dracula: {
    id: 'dracula',
    name: 'Dracula',
    description: 'High-contrast purple/pink palette',
    mode: 'dark',
    primary: '#bd93f9',
    success: '#50fa7b',
    error: '#ff5555',
    warning: '#f1fa8c',
    muted: '#6272a4',
    user: '#8be9fd',
    assistant: '#f8f8f2',
    code: '#f8f8f2',
    codeBg: '#282a36',
    diffAdd: '#50fa7b',
    diffDel: '#ff5555',
    diffHunk: '#bd93f9',
    thinking: '#6272a4',
    accent: '#ff79c6',
    toolRead: '#8be9fd',
    toolEdit: '#ff79c6',
    toolExec: '#f1fa8c',
    toolSearch: '#6272a4',
    toolOther: '#6272a4',
  },
  // Gruvbox — warm retro, easy on the eyes
  gruvbox: {
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'Warm retro, low eye strain',
    mode: 'dark',
    primary: '#83a598',
    success: '#b8bb26',
    error: '#fb4934',
    warning: '#fe8019',
    muted: '#928374',
    user: '#83a598',
    assistant: '#ebdbb2',
    code: '#ebdbb2',
    codeBg: '#282828',
    diffAdd: '#b8bb26',
    diffDel: '#fb4934',
    diffHunk: '#d3869b',
    thinking: '#928374',
    accent: '#d3869b',
    toolRead: '#83a598',
    toolEdit: '#d3869b',
    toolExec: '#fe8019',
    toolSearch: '#928374',
    toolOther: '#928374',
  },
  // Nord — arctic, cool blue-grey
  nord: {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic blue-grey, calm contrast',
    mode: 'dark',
    primary: '#88c0d0',
    success: '#a3be8c',
    error: '#bf616a',
    warning: '#ebcb8b',
    muted: '#4c566a',
    user: '#81a1c1',
    assistant: '#e5e9f0',
    code: '#eceff4',
    codeBg: '#2e3440',
    diffAdd: '#a3be8c',
    diffDel: '#bf616a',
    diffHunk: '#81a1c1',
    thinking: '#4c566a',
    accent: '#b48ead',
    toolRead: '#88c0d0',
    toolEdit: '#b48ead',
    toolExec: '#ebcb8b',
    toolSearch: '#4c566a',
    toolOther: '#4c566a',
  },
  // Solarized — classic ANSI-friendly light/dark
  solarized: {
    id: 'solarized',
    name: 'Solarized',
    description: 'Classic light/dark duality',
    mode: 'dark',
    primary: '#268bd2',
    success: '#859900',
    error: '#dc322f',
    warning: '#b58900',
    muted: '#657b83',
    user: '#2aa198',
    assistant: '#eee8d5',
    code: '#fdf6e3',
    codeBg: '#073642',
    diffAdd: '#859900',
    diffDel: '#dc322f',
    diffHunk: '#268bd2',
    thinking: '#657b83',
    accent: '#6c71c4',
    toolRead: '#2aa198',
    toolEdit: '#6c71c4',
    toolExec: '#b58900',
    toolSearch: '#657b83',
    toolOther: '#657b83',
  },
  // Matrix — terminal-green terminal
  matrix: {
    id: 'matrix',
    name: 'Matrix',
    description: 'Terminal-green monochrome',
    mode: 'dark',
    primary: '#00ff41',
    success: '#00ff41',
    error: '#ff2e2e',
    warning: '#ffff55',
    muted: '#00aa2a',
    user: '#00ff41',
    assistant: '#d0ffd0',
    code: '#c8ffc8',
    codeBg: '#001a08',
    diffAdd: '#00ff41',
    diffDel: '#ff2e2e',
    diffHunk: '#00cfff',
    thinking: '#00aa2a',
    accent: '#00ff41',
    toolRead: '#00ff41',
    toolEdit: '#00cfff',
    toolExec: '#ffff55',
    toolSearch: '#00aa2a',
    toolOther: '#00aa2a',
  },
  // Light — GitHub-light inspired: high-contrast dark text on a white background.
  // Every slot passes WCAG AA on #ffffff, so a Mac-default (light) terminal stays readable.
  light: {
    id: 'light',
    name: 'Light',
    description: 'High-contrast light (white background)',
    mode: 'light',
    primary: '#0969da',
    success: '#1a7f37',
    error: '#cf222e',
    warning: '#9a6700',
    muted: '#59636e',
    user: '#0969da',
    assistant: '#1f2328',
    code: '#1f2328',
    codeBg: '#f6f8fa',
    diffAdd: '#1a7f37',
    diffDel: '#cf222e',
    diffHunk: '#0969da',
    thinking: '#59636e',
    accent: '#8250df',
    toolRead: '#0969da',
    toolEdit: '#8250df',
    toolExec: '#9a6700',
    toolSearch: '#59636e',
    toolOther: '#59636e',
  },
  // Gruvbox Light — warm paper background (#fbf1c7) with dark warm-grey text;
  // a softer alternative to the white `light` theme for light terminals.
  'gruvbox-light': {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    description: 'Warm paper background, soft contrast',
    mode: 'light',
    primary: '#076678',
    success: '#79740e',
    error: '#9d0006',
    warning: '#b57614',
    muted: '#7c6f64',
    user: '#076678',
    assistant: '#282828',
    code: '#282828',
    codeBg: '#ebdbb2',
    diffAdd: '#79740e',
    diffDel: '#9d0006',
    diffHunk: '#076678',
    thinking: '#7c6f64',
    accent: '#8f3f71',
    toolRead: '#076678',
    toolEdit: '#8f3f71',
    toolExec: '#b57614',
    toolSearch: '#7c6f64',
    toolOther: '#7c6f64',
  },
};

/** Fallback used when an unknown/custom id is configured. */
export const FALLBACK_THEME_ID: ThemeId = 'default';

/** The mutable singleton palette object bound to the active theme id.
 *  `applyTheme()` copies the resolved palette INTO this object, so existing
 *  `theme` references see the new colors on the next render (no remount needed). */
export const themeColors: ThemeColors = { ...THEMES[FALLBACK_THEME_ID] };

/**
 * Active theme id — the fallback resolution happens lazily in applyTheme(), and
 * setActiveThemeId() records only known ids (unknown ids keep the previous one).
 * Kept module-scoped so the singleton `theme` object in theme.ts can switch at
 * runtime without the components needing a context/provider.
 */
let activeThemeId: ThemeId = FALLBACK_THEME_ID;

/** The currently active theme id (initialized to the fallback default). */
export function currentThemeId(): ThemeId {
  return activeThemeId;
}

/** Record a theme id as active; unknown ids are ignored (keeps the previous). */
export function setActiveThemeId(id: string | undefined): void {
  if (isThemeId(id)) activeThemeId = id;
}

/**
 * Apply the active theme id to the shared `themeColors` object (in place) so
 * components that already imported `theme` pick up the new palette on the next
 * render. Unknown/custom ids silently keep the default palette instead of
 * throwing, so a stale config value never crashes the renderer.
 * Returns the shared object for convenience (theme.ts uses it as its export).
 */
export function applyTheme(id?: string): ThemeColors {
  const palette = resolveTheme(id ?? currentThemeId());
  Object.assign(themeColors, palette);
  return themeColors;
}

export function isThemeId(v: string | undefined): v is ThemeId {
  return !!v && (THEME_IDS as readonly string[]).includes(v);
}

/** Resolve a configured/CLI/command theme id; unknown ids fall back to the default. */
export function resolveTheme(id: string | undefined): ThemeDef {
  return isThemeId(id) ? THEMES[id] : THEMES[FALLBACK_THEME_ID];
}

/** List of built-in themes as human-readable lines (for the bare `/theme` command). */
export function themeListing(): string[] {
  return THEME_IDS.map((id) => {
    const t = THEMES[id];
    return `  ${id.padEnd(12)} ${t.name} — ${t.description} [${t.mode}]`;
  });
}

/* ---------------------------------------------------------------------------
 * Contrast helpers (used by tests to guard readability on any background)
 * ------------------------------------------------------------------------- */

/** Relative luminance of a #rrggbb color (WCAG 2.x formula, 0 = black, 1 = white). */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Background luminance each theme is designed for (approx: white for light, near-black for dark). */
export function themeBackgroundLuminance(theme: ThemeDef): number {
  return theme.mode === 'light' ? 1 : 0;
}