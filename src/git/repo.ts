import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface RepoInfo {
  isGit: boolean;
  branch: string | null;
  /** Project memory document content (CLAUDE.md/AGENTS.md/DEEPCODE.md, by priority) */
  projectDocs: string[];
}

const MEMORY_FILES = ['DEEPCODE.md', 'CLAUDE.md', 'AGENTS.md'];

export async function detectRepo(workspace: string): Promise<RepoInfo> {
  const info: RepoInfo = { isGit: false, branch: null, projectDocs: [] };
  try {
    const gitDir = join(workspace, '.git');
    const st = await stat(gitDir);
    info.isGit = st.isDirectory() || st.isFile(); // .git is a file in worktree scenarios
    if (info.isGit) {
      const head = join(workspace, '.git', 'HEAD');
      if (existsSync(head)) {
        const content = (await readFile(head, 'utf8')).trim();
        const m = /^ref:\s*refs\/heads\/(.+)$/.exec(content);
        info.branch = m?.[1] ?? null;
      }
    }
  } catch {
    info.isGit = false;
  }
  for (const name of MEMORY_FILES) {
    const p = join(workspace, name);
    if (existsSync(p)) {
      try {
        info.projectDocs.push((await readFile(p, 'utf8')).slice(0, 200_000));
      } catch {
        // Ignore
      }
    }
  }
  return info;
}
