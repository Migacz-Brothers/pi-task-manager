import type { ExecResult } from '../harness-adapter.ts';

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
  stdin?: string
): Promise<ExecResult> {
  const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const proc = Bun.spawn({
    cmd: ['docker', 'exec', '-i', ...envArgs, containerId, ...cmd],
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });

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
