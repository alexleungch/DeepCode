import { applyTheme, currentThemeId } from './themes.js';

/**
 * Terminal color theme — the ACTIVE palette at runtime.
 *
 * This is a mutable singleton: components import `theme` and read colors at render
 * time, so switching themes re-renders the whole TUI with the new palette
 * (no remount needed). `applyTheme(id)` swaps the underlying object; unknown ids
 * fall back to the default palette (see themes.ts for the registry + resolvers).
 *
 * The default object is also constructed from the built-in default palette, so
 * imports remain safe in tests / headless code that never call applyTheme().
 */
export const theme = applyTheme(currentThemeId());