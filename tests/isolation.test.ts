import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec } from '../src/spec-loader.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import type { FinalResult, FinalStatus } from '../src/types.ts';
import { createWorktree, removeWorktree, commitAll } from '../src/infra/git-manager.ts';

// ── Git/worktree manager: real git ───────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode: proc.exitCode ?? 1, stdout: stdout.trim() };
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)).exitCode === 0;
}

describe('isolation: git/worktree manager', () => {
  let repo: string;
  let wtBase: string;

  beforeEach(async () => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    repo = join(tmpdir(), `pi-iso-repo-${stamp}`);
    wtBase = join(tmpdir(), `pi-iso-wt-${stamp}`);
    mkdirSync(repo, { recursive: true });
    mkdirSync(wtBase, { recursive: true });
    await git(['init', '-b', 'main'], repo);
    await git(['config', 'user.email', 'test@example.com'], repo);
    await git(['config', 'user.name', 'Test'], repo);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'initial'], repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  });

  test('creates a worktree on the named branch; commits land on that branch', async () => {
    const wt = join(wtBase, 'task');
    await createWorktree(repo, 'feat/iso', wt);

    expect(existsSync(wt)).toBe(true);
    expect(await branchExists(repo, 'feat/iso')).toBe(true);

    // A commit made in the worktree advances feat/iso, not main.
    writeFileSync(join(wt, 'work.txt'), 'work\n');
    await commitAll(wt, 'did work');

    const log = await git(['log', '--oneline', 'feat/iso'], repo);
    expect(log.stdout).toContain('did work');
    const mainLog = await git(['log', '--oneline', 'main'], repo);
    expect(mainLog.stdout).not.toContain('did work');
  });

  test('removing the worktree keeps the branch and its commits (success cleanup)', async () => {
    const wt = join(wtBase, 'task');
    await createWorktree(repo, 'feat/keep', wt);
    writeFileSync(join(wt, 'work.txt'), 'work\n');
    await commitAll(wt, 'committed work');
    const sha = (await git(['rev-parse', 'feat/keep'], repo)).stdout;

    await removeWorktree(repo, wt);

    expect(existsSync(join(wt, 'work.txt'))).toBe(false); // directory gone
    expect(await branchExists(repo, 'feat/keep')).toBe(true); // branch kept
    // Commit is intact in the shared object store.
    expect((await git(['rev-parse', 'feat/keep'], repo)).stdout).toBe(sha);
    expect((await git(['cat-file', '-t', sha], repo)).stdout).toBe('commit');
  });

  test('a pre-existing branch is reused, not errored (documented behavior)', async () => {
    await git(['branch', 'feat/pre'], repo);
    const wt = join(wtBase, 'task');

    await expect(createWorktree(repo, 'feat/pre', wt)).resolves.toBeUndefined();

    // Worktree HEAD is on the pre-existing branch.
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], wt)).stdout).toBe('feat/pre');
  });

  test('a stale worktree registration at the same path is reconciled (reused)', async () => {
    const wt = join(wtBase, 'task');
    await createWorktree(repo, 'feat/stale', wt);
    writeFileSync(join(wt, 'work.txt'), 'work\n');
    await commitAll(wt, 'progress');

    // Second call with the same path (as a crashed run would re-attempt) is a
    // no-op reuse, not a failure, and preserves the in-progress commit.
    await expect(createWorktree(repo, 'feat/stale', wt)).resolves.toBeUndefined();
    expect(existsSync(join(wt, 'work.txt'))).toBe(true);
    expect((await git(['log', '--oneline', 'feat/stale'], repo)).stdout).toContain('progress');
  });

  test('two tasks on different branches do not share or corrupt working trees', async () => {
    const wtA = join(wtBase, 'a');
    const wtB = join(wtBase, 'b');
    await createWorktree(repo, 'feat/a', wtA);
    await createWorktree(repo, 'feat/b', wtB);

    writeFileSync(join(wtA, 'only-a.txt'), 'A\n');
    await commitAll(wtA, 'work A');
    writeFileSync(join(wtB, 'only-b.txt'), 'B\n');
    await commitAll(wtB, 'work B');

    // Each worktree sees only its own file…
    expect(existsSync(join(wtA, 'only-a.txt'))).toBe(true);
    expect(existsSync(join(wtA, 'only-b.txt'))).toBe(false);
    expect(existsSync(join(wtB, 'only-b.txt'))).toBe(true);
    expect(existsSync(join(wtB, 'only-a.txt'))).toBe(false);

    // …and each branch carries only its own commit.
    expect((await git(['log', '--oneline', 'feat/a'], repo)).stdout).toContain('work A');
    expect((await git(['log', '--oneline', 'feat/a'], repo)).stdout).not.toContain('work B');
    expect((await git(['log', '--oneline', 'feat/b'], repo)).stdout).toContain('work B');
    expect((await git(['log', '--oneline', 'feat/b'], repo)).stdout).not.toContain('work A');
  });
});

// ── Engine: worktree binding & cleanup disposition (fakes) ─────────────────────────

function ndjson(status: FinalStatus, summary = ''): string {
  return JSON.stringify({ type: 'final_result', status, summary });
}

interface IsoRig {
  deps: EngineDeps;
  created: Array<{ repoPath: string; branch: string; worktreePath: string }>;
  removed: string[];
  boundPaths: string[];
  commitPaths: string[];
}

/** Engine deps that record worktree/container wiring; verify runs for real via `sh -c`. */
function makeRig(harnessByBody: Record<string, FinalResult> = {}): IsoRig {
  const created: IsoRig['created'] = [];
  const removed: string[] = [];
  const boundPaths: string[] = [];
  const commitPaths: string[] = [];

  const deps: EngineDeps = {
    createWorktree: async (repoPath, branch, worktreePath) => {
      created.push({ repoPath, branch, worktreePath });
    },
    removeWorktree: async (_repoPath, worktreePath) => {
      removed.push(worktreePath);
    },
    startContainer: async (_image, repoPath) => {
      boundPaths.push(repoPath); // engine binds the worktree path here
      return 'fake-container';
    },
    stopContainer: async () => {},
    commitAll: async (path) => {
      commitPaths.push(path);
    },
    diffChanges: async () => '',
    execInContainer: async (_cid, cmd, _env, stdin): Promise<ExecResult> => {
      if (cmd[0] === 'pi') {
        const body = stdin ?? '';
        const key = Object.keys(harnessByBody).find(k => body.includes(k));
        const r = key ? harnessByBody[key] : { status: 'passed' as FinalStatus, summary: 'ok' };
        return { exitCode: 0, stdout: ndjson(r.status, r.summary), stderr: '' };
      }
      if (cmd[0] === 'cat') return { exitCode: 1, stdout: '', stderr: 'no file' };
      if (cmd[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode: proc.exitCode ?? 1, stdout: out, stderr: err };
    },
  };

  return { deps, created, removed, boundPaths, commitPaths };
}

describe('isolation: engine wiring & cleanup', () => {
  let dir: string;
  let dbPath: string;
  let wtBase: string;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dir = join(tmpdir(), `pi-iso-eng-${stamp}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(tmpdir(), `pi-iso-eng-${stamp}.db`);
    wtBase = join(tmpdir(), `pi-iso-eng-wt-${stamp}`);
    writeFileSync(join(dir, 'README.md'), `---\nslug: t\nbranch: feat/t\n---\n`, 'utf-8');
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
    const tasks = new TaskRepository(db);
    const subs = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'feat/t');
    return subs.getStatus(subs.findId(taskId, slug));
  }

  function run(rig: IsoRig, db: ReturnType<typeof openDb>) {
    return runTask(loadTaskSpec(dir), {
      repoPath: dir,
      apiKey: 'k',
      db,
      deps: rig.deps,
      worktreesDir: wtBase,
      attemptTimeoutMs: 200,
    });
  }

  test('creates the worktree on the frontmatter branch and binds the container to it', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    const wt = join(wtBase, 't');
    expect(rig.created).toEqual([{ repoPath: dir, branch: 'feat/t', worktreePath: wt }]);
    expect(rig.boundPaths).toEqual([wt]); // container bound to the worktree, not the repo
    expect(rig.commitPaths).toEqual([wt]); // commit targets the worktree
    db.close();
  });

  test('on success the worktree is removed (branch is kept upstream of cleanup)', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b');
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('passed');
    expect(statusOf(db, 'b')).toBe('passed');
    expect(rig.removed).toEqual([join(wtBase, 't')]); // teardown happened exactly once
    db.close();
  });

  test('on needs_human (halt) the worktree is kept for inspection', async () => {
    writeSub('01-a.md', 'a', 'false'); // verify always red → escalates after K
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('needs_human');
    expect(rig.removed).toEqual([]); // worktree NOT removed
    db.close();
  });

  test('a harness crash also keeps the worktree', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig({ 'body a': { status: 'harness_error', summary: 'boom' } });

    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('needs_human');
    expect(rig.removed).toEqual([]);
    db.close();
  });

  test('two tasks get distinct worktree paths and branches', async () => {
    // Task 1
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig1 = makeRig();
    await run(rig1, db);

    // Task 2: a different spec dir / slug / branch.
    const dir2 = join(tmpdir(), `pi-iso-eng2-${process.pid}-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'README.md'), `---\nslug: t2\nbranch: feat/t2\n---\n`, 'utf-8');
    writeFileSync(join(dir2, '01-a.md'), `---\nslug: a\nverify: 'true'\n---\nbody a\n`, 'utf-8');
    const rig2 = makeRig();
    await runTask(loadTaskSpec(dir2), {
      repoPath: dir2, apiKey: 'k', db, deps: rig2.deps, worktreesDir: wtBase, attemptTimeoutMs: 200,
    });

    expect(rig1.created[0].worktreePath).toBe(join(wtBase, 't'));
    expect(rig2.created[0].worktreePath).toBe(join(wtBase, 't2'));
    expect(rig1.created[0].branch).toBe('feat/t');
    expect(rig2.created[0].branch).toBe('feat/t2');
    expect(rig1.created[0].worktreePath).not.toBe(rig2.created[0].worktreePath);

    rmSync(dir2, { recursive: true, force: true });
    db.close();
  });
});
