import type { ExecResult } from '../harness-adapter.ts';

/**
 * Docker label key stamped on every task container. Carrying the task slug as the
 * value lets the engine bind a container to its task and lets slice 08's
 * reconciler enumerate (and kill) orphaned task containers after a crash by
 * filtering on this key alone.
 */
export const TASK_LABEL_KEY = 'pi-task-manager.task';

/** The full `key=value` label for a task's container. */
export function taskLabel(slug: string): string {
  return `${TASK_LABEL_KEY}=${slug}`;
}

async function readText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return new Response(stream).text();
}

export async function startContainer(
  image: string,
  repoPath: string,
  label: string,
  envVars: Record<string, string> = {}
): Promise<string> {
  const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const proc = Bun.spawn({
    cmd: [
      'docker', 'run', '-d',
      '--rm',
      '--label', label,
      '-v', `${repoPath}:/workspace`,
      '-w', '/workspace',
      ...envArgs,
      image,
      'sleep', 'infinity',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    readText(proc.stdout),
    readText(proc.stderr),
    proc.exited,
  ]);

  if (proc.exitCode !== 0) {
    throw new Error(`Failed to start container: ${stderr.trim()}`);
  }

  return stdout.trim();
}

export async function execInContainer(
  containerId: string,
  cmd: string[],
  envVars: Record<string, string> = {},
  stdin?: string,
  signal?: AbortSignal
): Promise<ExecResult> {
  const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const proc = Bun.spawn({
    cmd: ['docker', 'exec', '-i', ...envArgs, containerId, ...cmd],
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Let the caller (e.g. the engine's per-attempt timeout) kill a hung exec.
  const onAbort = () => proc.kill();
  if (signal) {
    if (signal.aborted) proc.kill();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const [stdout, stderr] = await Promise.all([
      readText(proc.stdout),
      readText(proc.stderr),
      proc.exited,
    ]);

    return {
      exitCode: proc.exitCode ?? 1,
      stdout,
      stderr,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function stopContainer(containerId: string): Promise<void> {
  const proc = Bun.spawn(['docker', 'stop', containerId]);
  await proc.exited;
}

export async function killContainersByLabel(label: string): Promise<void> {
  const listProc = Bun.spawn({
    cmd: ['docker', 'ps', '-q', '--filter', `label=${label}`],
    stdout: 'pipe',
  });
  const [stdout] = await Promise.all([readText(listProc.stdout), listProc.exited]);
  const ids = stdout.trim().split('\n').filter(Boolean);

  await Promise.all(
    ids.map(id => {
      const p = Bun.spawn(['docker', 'kill', id]);
      return p.exited;
    })
  );
}
