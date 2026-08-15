/** Terminal color theme */
export const theme = {
  primary: '#4f9cf9',
  success: '#3fb950',
  error: '#f85149',
  warning: '#d29922',
  muted: '#8b949e',
  user: '#58a6ff',
  assistant: '#e6edf3',
  code: '#c9d1d9',
  diffAdd: '#3fb950',
  diffDel: '#f85149',
  diffHunk: '#58a6ff',
  thinking: '#6e7681',
  accent: '#bc8cff',
} as const;

export function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
