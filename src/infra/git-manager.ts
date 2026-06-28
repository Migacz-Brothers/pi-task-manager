import { resolve } from 'path';

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function git(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode ?? 1, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** True if `git worktree list --porcelain` output already registers `worktreePath`. */
function worktreeRegistered(porcelain: string, worktreePath: string): boolean {
  const target = resolve(worktreePath);
  return porcelain
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length).trim()))
    .includes(target);
}

/**
 * Create a git worktree at `worktreePath` checked out on `branch`, isolating the
 * task's work from the main checkout and from sibling tasks. All worktrees share
 * the main repo's `.git` object store, so commits made here are durable
 * independent of whether the worktree directory survives.
 *
 * Edge cases (documented behavior):
 * - **Branch already exists** → reuse it (check it out into the new worktree)
 *   rather than erroring; the task's commits simply continue that branch.
 * - **Stale worktree from a prior crashed run** → reconcile: `prune` clears
 *   metadata for vanished directories, and a worktree still registered at the
 *   target path is reused as-is (overlaps with slice 08 reconciliation).
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string
): Promise<void> {
  // Drop administrative metadata for worktrees whose directory has disappeared,
  // so re-adding at the same path doesn't trip over a stale registration.
  await git(['worktree', 'prune'], repoPath);

  // A worktree still registered at this path (a prior run that didn't clean up)
  // is reused — isolation is intact and its branch checkout is already correct.
  const listed = await git(['worktree', 'list', '--porcelain'], repoPath);
  if (worktreeRegistered(listed.stdout, worktreePath)) return;

  const branchExists =
    (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)).exitCode === 0;

  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath];

  const result = await git(args, repoPath);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree for branch '${branch}': ${result.stderr}`);
  }
}

/**
 * Remove the worktree at `worktreePath`, **keeping the branch**. Because every
 * worktree shares the main repo's `.git`, the branch and all its commits live on
 * after the directory is gone — this is what makes the success-cleanup rule
 * (remove worktree, keep branch) lossless. `--force` is needed because the
 * worktree holds a live checkout (and possibly untracked files).
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const result = await git(['worktree', 'remove', '--force', worktreePath], repoPath);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to remove worktree at '${worktreePath}': ${result.stderr}`);
  }
}

export async function commitAll(repoPath: string, message: string): Promise<void> {
  const add = await git(['add', '-A'], repoPath);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr}`);
  }

  // Nothing staged → nothing to commit, so this is a no-op rather than an error.
  // This is what makes a subtask's checkpoint commit idempotent: if a crash lands
  // between "commit" and "status recorded" (the subtask is left `running`), the
  // recovery re-run reaches this point with the change already committed and the
  // worktree clean — we must not error or fabricate a duplicate commit.
  const staged = await git(['diff', '--cached', '--quiet'], repoPath);
  if (staged.exitCode === 0) return;

  const commit = await git(['commit', '-m', message], repoPath);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }
}

export async function currentBranch(repoPath: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  return stdout;
}

/**
 * Diff of every uncommitted change in the worktree against HEAD, including
 * untracked files. Staging with `add -A` first is what lets `diff --cached`
 * surface new files; the staging is harmless under fix-forward since the next
 * `commitAll` re-adds everything anyway. Returns the raw diff (possibly empty).
 */
export async function diffChanges(repoPath: string): Promise<string> {
  await git(['add', '-A'], repoPath);
  const { stdout } = await git(['diff', '--cached', 'HEAD'], repoPath);
  return stdout;
}
