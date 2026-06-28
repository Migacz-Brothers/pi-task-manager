import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec } from '../src/spec-loader.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import { runPiHarness, ENGINE_OWNS_GIT_INSTRUCTION } from '../src/harness-adapter.ts';
import type { FinalStatus } from '../src/types.ts';
import { resolveBaseImage, ImageResolutionError } from '../src/infra/image-resolver.ts';
import { resolveApiKey, AuthError, SECRETS_FILE } from '../src/infra/auth.ts';

function tmp(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ── Image resolution: dev container vs. override vs. error ────────────────────────

describe('containers: image resolution', () => {
  let repo: string;

  beforeEach(() => {
    repo = tmp('pi-img');
    mkdirSync(repo, { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function dc(rel: string, content: string) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  test('frontmatter image override is honored', () => {
    // Even with a dev container present, the override wins.
    dc('.devcontainer/devcontainer.json', JSON.stringify({ image: 'node:20' }));
    const base = resolveBaseImage(repo, 'my/custom:tag');
    expect(base).toEqual({ kind: 'image', image: 'my/custom:tag', source: 'override' });
  });

  test('no override + .devcontainer image is used (repo toolchain)', () => {
    dc('.devcontainer/devcontainer.json', JSON.stringify({ image: 'python:3.12' }));
    const base = resolveBaseImage(repo);
    expect(base).toEqual({ kind: 'image', image: 'python:3.12', source: 'devcontainer' });
  });

  test('devcontainer.json with JSONC comments and trailing commas parses', () => {
    dc(
      '.devcontainer/devcontainer.json',
      `{
        // pin the toolchain
        "name": "dev",
        "image": "node:20-bookworm", /* base */
      }`
    );
    expect(resolveBaseImage(repo)).toEqual({ kind: 'image', image: 'node:20-bookworm', source: 'devcontainer' });
  });

  test('devcontainer.json build.dockerfile resolves to a Dockerfile build', () => {
    dc('.devcontainer/devcontainer.json', JSON.stringify({ build: { dockerfile: 'Dockerfile' } }));
    dc('.devcontainer/Dockerfile', 'FROM ubuntu:22.04\n');
    const base = resolveBaseImage(repo);
    expect(base.kind).toBe('dockerfile');
    if (base.kind === 'dockerfile') {
      expect(base.dockerfile).toBe(join(repo, '.devcontainer', 'Dockerfile'));
      expect(base.context).toBe(join(repo, '.devcontainer'));
      expect(base.source).toBe('devcontainer');
    }
  });

  test('a bare .devcontainer/Dockerfile (no json) is used', () => {
    dc('.devcontainer/Dockerfile', 'FROM golang:1.22\n');
    const base = resolveBaseImage(repo);
    expect(base).toMatchObject({ kind: 'dockerfile', source: 'devcontainer' });
  });

  test('a root Dockerfile is the last-resort dev container', () => {
    dc('Dockerfile', 'FROM rust:1.79\n');
    const base = resolveBaseImage(repo);
    expect(base).toMatchObject({ kind: 'dockerfile', source: 'repo' });
  });

  test('no dev container and no override → actionable ImageResolutionError', () => {
    expect(() => resolveBaseImage(repo)).toThrow(ImageResolutionError);
    try {
      resolveBaseImage(repo);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('image:'); // points at the override remedy
      expect(msg.toLowerCase()).toContain('devcontainer');
    }
  });

  test('malformed devcontainer.json fails with a clear error', () => {
    dc('.devcontainer/devcontainer.json', '{ not json');
    expect(() => resolveBaseImage(repo)).toThrow(/not valid JSON/);
  });
});

// ── Auth: source the key, fail fast when absent ──────────────────────────────────

describe('containers: auth resolution', () => {
  let repo: string;

  beforeEach(() => {
    repo = tmp('pi-auth');
    mkdirSync(repo, { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('reads PI_API_KEY from the host env', () => {
    expect(resolveApiKey(repo, { PI_API_KEY: 'sk-host' })).toBe('sk-host');
  });

  test('falls back to ANTHROPIC_API_KEY', () => {
    expect(resolveApiKey(repo, { ANTHROPIC_API_KEY: 'sk-anthropic' })).toBe('sk-anthropic');
  });

  test('reads from the gitignored secrets file when env is empty', () => {
    writeFileSync(join(repo, SECRETS_FILE), '# secrets\nANTHROPIC_API_KEY="sk-from-file"\n', 'utf-8');
    expect(resolveApiKey(repo, {})).toBe('sk-from-file');
  });

  test('host env takes precedence over the secrets file', () => {
    writeFileSync(join(repo, SECRETS_FILE), 'PI_API_KEY=sk-file\n', 'utf-8');
    expect(resolveApiKey(repo, { PI_API_KEY: 'sk-env' })).toBe('sk-env');
  });

  test('missing key fails fast with an actionable AuthError', () => {
    expect(() => resolveApiKey(repo, {})).toThrow(AuthError);
    try {
      resolveApiKey(repo, {});
    } catch (e) {
      expect((e as Error).message).toContain('PI_API_KEY');
      expect((e as Error).message).toContain(SECRETS_FILE);
    }
  });
});

// ── Harness adapter: autonomy + git boundary + exec-time auth ─────────────────────

describe('containers: harness invocation', () => {
  test('runs pi with full auto-approval and the engine-owns-git instruction; key at exec time', async () => {
    let captured: { cmd: string[]; env: Record<string, string> } | undefined;
    await runPiHarness(
      'cid',
      'do the work',
      'sk-secret',
      async (_cid, cmd, env): Promise<ExecResult> => {
        captured = { cmd, env };
        return { exitCode: 0, stdout: JSON.stringify({ type: 'final_result', status: 'passed', summary: 'ok' }), stderr: '' };
      }
    );

    expect(captured).toBeDefined();
    // Fully autonomous: no per-tool permission prompts.
    expect(captured!.cmd).toContain('--auto-approve');
    // Instruct-only git boundary delivered as a system-prompt instruction.
    expect(captured!.cmd).toContain('--append-system-prompt');
    expect(captured!.cmd).toContain(ENGINE_OWNS_GIT_INSTRUCTION);
    // Auth injected at exec time.
    expect(captured!.env.PI_API_KEY).toBe('sk-secret');
  });
});

// ── Engine wiring: lifecycle, labels, exec-time-only auth ─────────────────────────

function ndjson(status: FinalStatus, summary = ''): string {
  return JSON.stringify({ type: 'final_result', status, summary });
}

interface ContainerRig {
  deps: EngineDeps;
  starts: Array<{ image: string; repoPath: string; label: string; env: Record<string, string> }>;
  piExecEnvs: Array<Record<string, string>>;
  resolveCalls: Array<{ repoPath: string; override: string | undefined; slug: string }>;
  stops: string[];
}

function makeRig(harnessByBody: Record<string, FinalStatus> = {}): ContainerRig {
  const starts: ContainerRig['starts'] = [];
  const piExecEnvs: ContainerRig['piExecEnvs'] = [];
  const resolveCalls: ContainerRig['resolveCalls'] = [];
  const stops: string[] = [];

  const deps: EngineDeps = {
    createWorktree: async () => {},
    removeWorktree: async () => {},
    resolveImage: async (repoPath, override, slug) => {
      resolveCalls.push({ repoPath, override, slug });
      return 'resolved-image:latest';
    },
    startContainer: async (image, repoPath, label, env) => {
      starts.push({ image, repoPath, label, env });
      return `cid-${starts.length}`;
    },
    stopContainer: async (cid) => {
      stops.push(cid);
    },
    commitAll: async () => {},
    diffChanges: async () => '',
    execInContainer: async (_cid, cmd, env, stdin): Promise<ExecResult> => {
      if (cmd[0] === 'pi') {
        piExecEnvs.push(env ?? {});
        const body = stdin ?? '';
        const key = Object.keys(harnessByBody).find(k => body.includes(k));
        const status = key ? harnessByBody[key] : ('passed' as FinalStatus);
        return { exitCode: 0, stdout: ndjson(status, 'ok'), stderr: '' };
      }
      if (cmd[0] === 'cat') return { exitCode: 1, stdout: '', stderr: 'no file' };
      if (cmd[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      // verify: run for real so its exit code is authoritative.
      const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode: proc.exitCode ?? 1, stdout: out, stderr: err };
    },
  };

  return { deps, starts, piExecEnvs, resolveCalls, stops };
}

describe('containers: engine lifecycle wiring', () => {
  let dir: string;
  let dbPath: string;
  let wtBase: string;

  beforeEach(() => {
    dir = tmp('pi-cont-eng');
    mkdirSync(dir, { recursive: true });
    dbPath = `${tmp('pi-cont-eng')}.db`;
    wtBase = tmp('pi-cont-wt');
    writeFileSync(join(dir, 'README.md'), `---\nslug: t\nbranch: feat/t\nimage: my/img:1\n---\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  function writeSub(file: string, slug: string, verify = 'true', body = `body ${slug}`) {
    writeFileSync(join(dir, file), `---\nslug: ${slug}\nverify: '${verify}'\n---\n${body}\n`, 'utf-8');
  }

  function statusOf(db: ReturnType<typeof openDb>, slug: string) {
    const taskId = new TaskRepository(db).upsert('t', 'feat/t');
    const subs = new SubtaskRepository(db);
    return subs.getStatus(subs.findId(taskId, slug));
  }

  function run(rig: ContainerRig, db: ReturnType<typeof openDb>) {
    return runTask(loadTaskSpec(dir), {
      repoPath: dir, apiKey: 'sk-secret', db, deps: rig.deps, worktreesDir: wtBase, attemptTimeoutMs: 500,
    });
  }

  test('resolves the image (honoring the override) and binds it to the container on the worktree', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    const wt = join(wtBase, 't');
    expect(rig.resolveCalls).toEqual([{ repoPath: wt, override: 'my/img:1', slug: 't' }]);
    expect(rig.starts).toHaveLength(1);
    expect(rig.starts[0].image).toBe('resolved-image:latest');
    expect(rig.starts[0].repoPath).toBe(wt);
    db.close();
  });

  test('labels the container by task slug (for orphan-kill in slice 08)', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    expect(rig.starts[0].label).toBe('pi-task-manager.task=t');
    db.close();
  });

  test('API key is absent at container-start and present only at exec time', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    // Never baked into the container's run config…
    expect(rig.starts[0].env).toEqual({});
    expect(JSON.stringify(rig.starts[0].env)).not.toContain('sk-secret');
    // …injected at exec time.
    expect(rig.piExecEnvs.length).toBeGreaterThan(0);
    expect(rig.piExecEnvs[0].PI_API_KEY).toBe('sk-secret');
    db.close();
  });

  test('container is torn down on completion', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('passed');
    expect(rig.stops).toHaveLength(1); // alive only during execution, torn down at the end
    db.close();
  });

  test('container is torn down on pause (needs_human after K failures)', async () => {
    writeSub('01-a.md', 'a', 'false'); // verify always red → escalates
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('needs_human');
    expect(rig.stops).toHaveLength(1); // no lingering container after a pause
    db.close();
  });

  test('resume starts a fresh container on the same worktree, skipping passed subtasks', async () => {
    writeSub('01-a.md', 'a', 'true');
    writeSub('02-b.md', 'b', 'true');
    const db = openDb(dbPath);

    // First run completes both.
    const rig1 = makeRig();
    await run(rig1, db);
    expect(rig1.starts).toHaveLength(1);

    // Second run (resume): a brand-new container, bound to the same worktree path.
    const rig2 = makeRig();
    await run(rig2, db);
    expect(rig2.starts).toHaveLength(1);
    expect(rig2.starts[0].repoPath).toBe(join(wtBase, 't')); // same host-persisted worktree
    expect(rig2.stops).toHaveLength(1);
    // Already-passed subtasks are not re-run in the fresh container.
    expect(rig2.piExecEnvs.length).toBe(0);
    db.close();
  });
});
