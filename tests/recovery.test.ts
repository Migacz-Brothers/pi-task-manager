import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { reconcile } from '../src/reconciler.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import type { TaskSpec, FinalStatus, SubtaskStatus } from '../src/types.ts';
import { loadTaskSpec } from '../src/spec-loader.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { TASK_LABEL_KEY, taskLabel } from '../src/infra/container-manager.ts';
import { commitAll, createWorktree, removeWorktree } from '../src/infra/git-manager.ts';

function tmp(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode: proc.exitCode ?? 1, stdout: stdout.trim() };
}

function ndjson(status: FinalStatus, summary = ''): string {
  return JSON.stringify({ type: 'final_result', status, summary });
}

// ── Reconciler unit: SQLite reset + orphan-container kill ──────────────────────────

describe('recovery: reconciler', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = `${tmp('pi-rec')}.db`;
  });
  afterEach(() => {
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  /** Seed a task + one subtask at the given status, return its repos + id. */
  function seed(db: ReturnType<typeof openDb>, slug: string, status: SubtaskStatus) {
    const taskRepo = new TaskRepository(db);
    const subRepo = new SubtaskRepository(db);
    const taskId = taskRepo.upsert(slug, `feat/${slug}`);
    const subId = subRepo.upsert(taskId, 'work', 'true', `hash-${slug}`);
    subRepo.setStatus(subId, status);
    return { subRepo, subId };
  }

  test('a subtask left `running` by a crash is reset to `pending`', async () => {
    const db = openDb(dbPath);
    const { subRepo, subId } = seed(db, 't', 'running');

    const report = await reconcile(db, { killOrphanContainers: async () => {} });

    expect(report.resetSubtasks).toBe(1);
    expect(subRepo.getStatus(subId)).toBe('pending');
    db.close();
  });

  test('terminal/idle statuses are left untouched — only `running` is reset', async () => {
    const db = openDb(dbPath);
    const passed = seed(db, 'p', 'passed');
    const pending = seed(db, 'q', 'pending');
    const needs = seed(db, 'r', 'needs_human');
    const failed = seed(db, 's', 'verify_failed');

    const report = await reconcile(db, { killOrphanContainers: async () => {} });

    expect(report.resetSubtasks).toBe(0);
    expect(passed.subRepo.getStatus(passed.subId)).toBe('passed');
    expect(pending.subRepo.getStatus(pending.subId)).toBe('pending');
    expect(needs.subRepo.getStatus(needs.subId)).toBe('needs_human');
    expect(failed.subRepo.getStatus(failed.subId)).toBe('verify_failed');
    db.close();
  });

  test('resets every `running` subtask across tasks, regardless of count', async () => {
    const db = openDb(dbPath);
    const a = seed(db, 'a', 'running');
    const b = seed(db, 'b', 'running');

    const report = await reconcile(db, { killOrphanContainers: async () => {} });

    expect(report.resetSubtasks).toBe(2);
    expect(a.subRepo.getStatus(a.subId)).toBe('pending');
    expect(b.subRepo.getStatus(b.subId)).toBe('pending');
    db.close();
  });

  test('orphaned containers are killed on startup (filtered by the task label key)', async () => {
    const db = openDb(dbPath);
    let killed = 0;

    await reconcile(db, { killOrphanContainers: async () => { killed++; } });

    expect(killed).toBe(1); // orphan cleanup always runs, even with nothing to reset
    // The production default targets every container carrying the engine's label.
    expect(taskLabel('anything').startsWith(`${TASK_LABEL_KEY}=`)).toBe(true);
    db.close();
  });
});

// ── End-to-end: crash mid-subtask, restart, re-run exactly that subtask ──────────────

/**
 * Engine deps backed by real git worktrees/commits but a fake container+harness
 * (mirrors the parallel slice's rig). `failCommitOnce.current` lets a test
 * simulate a crash *after* verify passed but *before* the checkpoint commit/row:
 * the first `commitAll` throws, propagating out of `runTask` and leaving the
 * subtask stuck `running` with nothing committed — exactly the crash window
 * recovery must repair.
 */
function makeGitDeps(failCommitOnce?: { current: boolean }): EngineDeps {
  const wtByContainer = new Map<string, string>();
  return {
    createWorktree,
    removeWorktree,
    resolveImage: async () => 'fake-image',
    startContainer: async (_image, repoPath) => {
      const id = `fake-container-${repoPath}`;
      wtByContainer.set(id, repoPath);
      return id;
    },
    stopContainer: async () => {},
    commitAll: async (repoPath, message) => {
      if (failCommitOnce?.current) {
        failCommitOnce.current = false;
        throw new Error('simulated crash before commit recorded');
      }
      return commitAll(repoPath, message);
    },
    diffChanges: async () => '',
    execInContainer: async (cid, cmd, _env, _stdin): Promise<ExecResult> => {
      const wt = wtByContainer.get(cid)!;
      if (cmd[0] === 'pi') {
        // Agent edits the worktree deterministically, so a re-run reproduces the
        // same content (no spurious second commit).
        writeFileSync(join(wt, 'work.txt'), 'done\n');
        return { exitCode: 0, stdout: ndjson('passed', 'ok'), stderr: '' };
      }
      if (cmd[0] === 'cat') return { exitCode: 1, stdout: '', stderr: 'no file' };
      if (cmd[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      const proc = Bun.spawn({ cmd, cwd: wt, stdout: 'pipe', stderr: 'pipe' });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode: proc.exitCode ?? 1, stdout: out, stderr: err };
    },
  };
}

describe('recovery: end-to-end crash and restart', () => {
  let repo: string;
  let wtBase: string;
  let dbPath: string;

  beforeEach(async () => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    repo = join(tmpdir(), `pi-rec-repo-${stamp}`);
    wtBase = join(tmpdir(), `pi-rec-wt-${stamp}`);
    dbPath = join(tmpdir(), `pi-rec-${stamp}.db`);
    mkdirSync(repo, { recursive: true });
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
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  /** A one-subtask task whose spec dir lives under the repo. */
  function writeTaskSpec(slug: string, verify = 'true'): TaskSpec {
    const dir = join(repo, '.specs', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `---\nslug: ${slug}\nbranch: feat/${slug}\n---\n`, 'utf-8');
    writeFileSync(join(dir, '01-work.md'), `---\nslug: work\nverify: '${verify}'\n---\nbody ${slug}\n`, 'utf-8');
    return loadTaskSpec(dir);
  }

  function statusOf(db: ReturnType<typeof openDb>, taskSlug: string, subSlug: string): SubtaskStatus {
    const taskId = new TaskRepository(db).upsert(taskSlug, `feat/${taskSlug}`);
    const subRepo = new SubtaskRepository(db);
    return subRepo.getStatus(subRepo.findId(taskId, subSlug));
  }

  function opts(db: ReturnType<typeof openDb>, deps: EngineDeps) {
    return { repoPath: repo, apiKey: 'k', db, deps, worktreesDir: wtBase, attemptTimeoutMs: 500 };
  }

  test('killing the engine mid-subtask, then restarting, re-runs exactly that subtask with no duplicate commit', async () => {
    const task = writeTaskSpec('t');
    const db = openDb(dbPath);

    // First run: crash right before the checkpoint commit is recorded.
    const fail = { current: true };
    await expect(runTask(task, opts(db, makeGitDeps(fail)))).rejects.toThrow();

    // The subtask is stuck `running` and nothing was committed.
    expect(statusOf(db, 't', 'work')).toBe('running');
    expect((await git(['log', '--oneline', 'feat/t'], repo)).stdout).not.toContain('t(work): passed');

    // Recovery flips it back to pending.
    const report = await reconcile(db, { killOrphanContainers: async () => {} });
    expect(report.resetSubtasks).toBe(1);
    expect(statusOf(db, 't', 'work')).toBe('pending');

    // Restart: re-runs the subtask and this time commits.
    await runTask(task, opts(db, makeGitDeps()));
    expect(statusOf(db, 't', 'work')).toBe('passed');

    // Exactly one checkpoint commit on the branch — no duplicate.
    const checkpoints = (await git(['log', '--oneline', 'feat/t'], repo)).stdout
      .split('\n')
      .filter(l => l.includes('t(work): passed'));
    expect(checkpoints).toHaveLength(1);
    db.close();
  });

  test('a completed-and-committed subtask is not re-run after a restart', async () => {
    const task = writeTaskSpec('t');
    const db = openDb(dbPath);

    // Full clean run: the subtask passes and is committed.
    await runTask(task, opts(db, makeGitDeps()));
    expect(statusOf(db, 't', 'work')).toBe('passed');

    // Reconcile sees nothing `running` — a passed subtask is left alone.
    const report = await reconcile(db, { killOrphanContainers: async () => {} });
    expect(report.resetSubtasks).toBe(0);

    // Restart: the passed subtask never re-runs, so no second checkpoint lands.
    let piRuns = 0;
    const deps = makeGitDeps();
    const inner = deps.execInContainer;
    deps.execInContainer = (cid, cmd, env, stdin, signal) => {
      if (cmd[0] === 'pi') piRuns++;
      return inner(cid, cmd, env, stdin, signal);
    };
    await runTask(task, opts(db, deps));

    expect(piRuns).toBe(0);
    const checkpoints = (await git(['log', '--oneline', 'feat/t'], repo)).stdout
      .split('\n')
      .filter(l => l.includes('t(work): passed'));
    expect(checkpoints).toHaveLength(1);
    db.close();
  });

  test('commitAll is idempotent: a re-run with the change already committed makes no duplicate commit', async () => {
    // Repairs the "crash between commit and status-record" window: the first run
    // committed but never recorded `passed`, so recovery re-runs and the agent
    // reproduces the same content — commitAll must no-op rather than error.
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    await commitAll(repo, 'first');
    const before = (await git(['rev-list', '--count', 'HEAD'], repo)).stdout;

    // Nothing new staged → no-op, no throw, no extra commit.
    await commitAll(repo, 'first');
    const after = (await git(['rev-list', '--count', 'HEAD'], repo)).stdout;

    expect(after).toBe(before);
  });

  test('a stale worktree from a crashed task is reused on restart (reconciled by the isolation rules)', async () => {
    const task = writeTaskSpec('t');
    const db = openDb(dbPath);

    // Crash before commit leaves the worktree on disk (success-only cleanup).
    await expect(runTask(task, opts(db, makeGitDeps({ current: true })))).rejects.toThrow();
    const wt = join(wtBase, 't');
    expect((await git(['worktree', 'list', '--porcelain'], repo)).stdout).toContain(wt);

    await reconcile(db, { killOrphanContainers: async () => {} });

    // Restart reuses the stale worktree without error and completes the task.
    await runTask(task, opts(db, makeGitDeps()));
    expect(statusOf(db, 't', 'work')).toBe('passed');
    db.close();
  });
});
