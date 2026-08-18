import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';

export interface WorktreeHandle {
  path: string;
  branch: string;
  git: SimpleGit;
  /** Main-branch commit at creation time (diff baseline) */
  baseRef: string;
}

interface WorktreeSummary {
  branch: string;
  commits: number;
  filesChanged: string[];
  diffStat: string;
}

/**
 * Git Worktree isolation: subagents work on a clean branch and are merged back into the main branch after confirmation.
 * - Not a git repo / dirty working tree → returns null (caller runs in place and warns)
 */
/** Create a worktree (simple-git has no worktreeAdd wrapper, so use raw commands) */
export async function createWorktree(workspace: string, label: string): Promise<WorktreeHandle | null> {
  try {
    const git = simpleGit(workspace);
    const status = await git.status();
    if (status.files.length > 0 || status.not_added.length > 0) return null; // Dirty working tree
    const baseDir = await mkdtemp(join(tmpdir(), 'deepcode-wt-'));
    const path = join(baseDir, 'worktree');
    // git 2.55 (Windows) rejects `worktree add -b` when the new branch name contains a slash
    // ("fatal: invalid reference: deepcode/sub-…"); the branch is internal-only (never shown or
    // merged by name), so sanitize it to a flat, still-unique name. Harmless on other platforms.
    const branch = `deepcode/sub-${label}`.replace(/[^\w.-]+/g, '-');
    const baseRef = (await git.revparse(['HEAD'])).trim();
    await git.raw(['worktree', 'add', '-b', branch, path]);
    const wtGit = simpleGit(path);
    return { path, branch, git: wtGit, baseRef };
  } catch {
    return null;
  }
}

/** Generate a merge summary (for approval display) */
export async function worktreeSummary(wt: WorktreeHandle): Promise<WorktreeSummary> {
  const git = simpleGit(wt.path);
  try {
    const diff = await git.diff([wt.baseRef + '..HEAD', '--stat']);
    const commits = await git.raw(['rev-list', '--count', wt.baseRef + '..HEAD']).catch(() => '0');
    return {
      branch: wt.branch,
      commits: Number(commits) || 0,
      filesChanged: [],
      diffStat: String(diff).trim(),
    };
  } catch (e) {
    return { branch: wt.branch, commits: 0, filesChanged: [], diffStat: `(could not generate summary: ${e instanceof Error ? e.message : String(e)})` };
  }
}

/** Merge the worktree branch back into the main branch and clean up; returns the error message on failure (keeps the worktree) */
export async function mergeWorktree(workspace: string, wt: WorktreeHandle, commitMessage: string): Promise<{ ok: boolean; error?: string }> {
  const mainGit = simpleGit(workspace);
  try {
    // Commit all changes on the sub-branch first (if uncommitted)
    const wtGit = simpleGit(wt.path);
    const status = await wtGit.status();
    if (status.files.length > 0 || status.not_added.length > 0) {
      await wtGit.add('.');
      await wtGit.commit(commitMessage);
    }
    await mainGit.mergeFromTo(wt.branch, await mainGit.revparse(['--abbrev-ref', 'HEAD']), { '--no-ff': null, '-m': commitMessage });
    await mainGit.branch(['-D', wt.branch]).catch(() => undefined);
    await mainGit.raw(['worktree', 'remove', '--force', wt.path]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Discard the worktree (kept when a merge is rejected, but cleanup is provided) */
export async function discardWorktree(workspace: string, wt: WorktreeHandle): Promise<void> {
  try {
    const mainGit = simpleGit(workspace);
    await mainGit.raw(['worktree', 'remove', '--force', wt.path]);
    await mainGit.branch(['-D', wt.branch]).catch(() => undefined);
  } catch {
    // Best-effort cleanup
  }
  await rm(wt.path, { recursive: true, force: true }).catch(() => undefined);
}
