import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

export interface AtCandidate {
  /** Path suffix to insert after `@` (relative to cwd / as typed, e.g. `src/`) */
  value: string;
  isDir: boolean;
}

const MAX_CANDIDATES = 20;

/** Resolve a `~`, absolute, or relative dir prefix to an absolute directory. */
function resolveDirPrefix(dirPart: string, cwd: string): string {
  if (dirPart === '~') return homedir();
  if (dirPart.startsWith('~/')) return path.join(homedir(), dirPart.slice(2));
  if (path.isAbsolute(dirPart)) return dirPart;
  return path.resolve(cwd, dirPart);
}

/**
 * Filesystem candidates for `@<partial>` completion: entries in the partial's
 * directory whose name starts with the partial's basename. Directories are marked
 * so the caller can append `/` (letting Tab descend into them).
 */
export function atCandidates(partial: string, cwd: string): AtCandidate[] {
  const sep = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'));
  const dirPart = sep >= 0 ? partial.slice(0, sep) : '';
  const basePart = sep >= 0 ? partial.slice(sep + 1) : partial;
  const dirAbs = resolveDirPrefix(dirPart, cwd);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return []; // missing dir / permission — no candidates
  }
  return entries
    .filter((d) => d.name.startsWith(basePart))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES)
    .map((d) => ({ value: dirPart ? `${dirPart}/${d.name}` : d.name, isDir: d.isDirectory() }));
}
