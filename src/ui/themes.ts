/**
 * TUI theme registry.
 *
 * Each theme maps every semantic UI slot to a terminal color (hex / ANSI name).
 * Themes are selectable:
 *   - config:  ui.theme = "<id>"  (default)
 *   - CLI:     deepcode --theme <id>
 *   - runtime: /theme [id]        inside the TUI
 *
 * Colors are chosen for 256-color terminals; Ink accepts hex strings and
 * named ANSI colors.
 */

export type ThemeColors = {
  primary: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  user: string;
  assistant: string;
  code: string;
  /** Background of code blocks (undefined = transparent) */
  codeBg?: string;
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
}

export const THEME_IDS = [
  'default',
  'dracula',
  'gruvbox',
  'nord',
  'solarized',
  'matrix',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const THEMES: Record<ThemeId, ThemeDef> = {
  // GitHub-dark-inspired baseline (the original palette)
  default: {
    id: 'default',
    name: 'Default',
    description: 'GitHub-dark inspired baseline',
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
    return `  ${id.padEnd(12)} ${t.name} — ${t.description}`;
  });
}