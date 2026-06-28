import type { ExecResult } from '../harness-adapter.ts';

/**
 * Run a command on the **host**, in `cwd`. Used for a `hitl` subtask's `approve`
 * verify: a hitl subtask runs no container, the human works directly in the host
 * worktree, so its verify must run there too — not inside an isolated container.
 */
export async function execHost(cwd: string, cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
}
