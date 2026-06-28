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

export async function ensureBranch(repoPath: string, branch: string): Promise<void> {
  const exists = await git(['rev-parse', '--verify', branch], repoPath);
  if (exists.exitCode !== 0) {
    const result = await git(['checkout', '-b', branch], repoPath);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create branch '${branch}': ${result.stderr}`);
    }
  } else {
    const result = await git(['checkout', branch], repoPath);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to checkout branch '${branch}': ${result.stderr}`);
    }
  }
}

export async function commitAll(repoPath: string, message: string): Promise<void> {
  const add = await git(['add', '-A'], repoPath);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr}`);
  }

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
