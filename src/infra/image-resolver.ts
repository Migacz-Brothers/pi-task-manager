import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

export class ImageResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageResolutionError';
  }
}

/**
 * The harness install layered on top of every task image. Kept as a single seam
 * so the install command lives in exactly one place; the engine never bakes the
 * API key here (auth is injected at `docker exec` time, see harness-adapter).
 */
export const HARNESS_INSTALL = 'curl -fsSL https://pkg.pi.dev/install.sh | sh';

/**
 * A resolved *base* image — before the harness layer. Either a named image to
 * pull, or a Dockerfile to build from the repo's dev container.
 */
export type BaseImage =
  | { kind: 'image'; image: string; source: 'override' | 'devcontainer' }
  | { kind: 'dockerfile'; dockerfile: string; context: string; source: 'devcontainer' | 'repo' };

/**
 * Strip `//` and `/* *​/` comments and trailing commas so a JSONC dev container
 * config (the VS Code default) parses with `JSON.parse`. Deliberately simple —
 * it does not attempt to honor comment-like sequences inside strings, which dev
 * container configs do not contain in practice.
 */
function stripJsonc(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
}

function parseDevcontainer(path: string): BaseImage | null {
  const raw = readFileSync(path, 'utf-8');
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
  } catch {
    throw new ImageResolutionError(`Dev container config at ${path} is not valid JSON`);
  }

  // A prebuilt image wins: `"image": "..."`.
  if (typeof cfg.image === 'string' && cfg.image.trim()) {
    return { kind: 'image', image: cfg.image.trim(), source: 'devcontainer' };
  }

  // Otherwise a `build.dockerfile` (or legacy top-level `dockerFile`) to build.
  const build = (cfg.build ?? {}) as Record<string, unknown>;
  const dockerfileName =
    (typeof build.dockerfile === 'string' && build.dockerfile) ||
    (typeof build.dockerFile === 'string' && build.dockerFile) ||
    (typeof cfg.dockerFile === 'string' && cfg.dockerFile) ||
    undefined;

  if (dockerfileName) {
    const dir = dirname(path);
    const context = typeof build.context === 'string' ? join(dir, build.context) : dir;
    return { kind: 'dockerfile', dockerfile: join(dir, dockerfileName), context, source: 'devcontainer' };
  }

  return null;
}

/**
 * Resolve the base image for a task's container.
 *
 * Precedence:
 *  1. frontmatter `image:` override.
 *  2. the repo's dev container — `.devcontainer/devcontainer.json` or
 *     `.devcontainer.json` (`image` or `build.dockerfile`), then a
 *     `.devcontainer/Dockerfile`, then a root `Dockerfile`.
 *  3. neither → an actionable {@link ImageResolutionError}.
 */
export function resolveBaseImage(repoPath: string, override?: string): BaseImage {
  if (override && override.trim()) {
    return { kind: 'image', image: override.trim(), source: 'override' };
  }

  for (const cfg of [join(repoPath, '.devcontainer', 'devcontainer.json'), join(repoPath, '.devcontainer.json')]) {
    if (existsSync(cfg)) {
      const resolved = parseDevcontainer(cfg);
      if (resolved) return resolved;
    }
  }

  const dcDockerfile = join(repoPath, '.devcontainer', 'Dockerfile');
  if (existsSync(dcDockerfile)) {
    return { kind: 'dockerfile', dockerfile: dcDockerfile, context: join(repoPath, '.devcontainer'), source: 'devcontainer' };
  }

  const rootDockerfile = join(repoPath, 'Dockerfile');
  if (existsSync(rootDockerfile)) {
    return { kind: 'dockerfile', dockerfile: rootDockerfile, context: repoPath, source: 'repo' };
  }

  throw new ImageResolutionError(
    `No container image for this task: ${repoPath} has no .devcontainer ` +
      `(devcontainer.json or Dockerfile) and no root Dockerfile. Add one, or set an ` +
      `'image:' override in the task's README.md frontmatter.`
  );
}

async function dockerBuild(dockerfile: string, contextDir: string, tag: string): Promise<void> {
  // `-f -` reads the Dockerfile from stdin so we can synthesize the harness
  // layer without writing a temp file into the repo's worktree.
  const proc = Bun.spawn({
    cmd: ['docker', 'build', '-t', tag, '-f', '-', contextDir],
    stdin: Buffer.from(dockerfile),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (proc.exitCode !== 0) {
    throw new ImageResolutionError(`docker build failed for '${tag}': ${stderr.trim()}`);
  }
}

/** A docker-safe tag fragment derived from a task slug. */
function tagFor(slug: string): string {
  const safe = slug.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^[-.]+/, '').toLowerCase() || 'task';
  return `pi-task-${safe}`;
}

/**
 * Resolve and build the concrete image a task runs in: the base image (override
 * or dev container) with the harness install layered on top. Returns the final
 * image tag. The base dev-container Dockerfile, if any, is built first and the
 * harness layer is `FROM` that build — so the repo's real toolchain is preserved
 * and the harness sits on top of it.
 */
export async function buildTaskImage(
  repoPath: string,
  override: string | undefined,
  slug: string
): Promise<string> {
  const base = resolveBaseImage(repoPath, override);

  let baseRef: string;
  if (base.kind === 'image') {
    baseRef = base.image;
  } else {
    baseRef = `${tagFor(slug)}-base:latest`;
    await dockerBuild(readFileSync(base.dockerfile, 'utf-8'), base.context, baseRef);
  }

  const finalTag = `${tagFor(slug)}:latest`;
  await dockerBuild(`FROM ${baseRef}\nRUN ${HARNESS_INSTALL}\n`, repoPath, finalTag);
  return finalTag;
}
