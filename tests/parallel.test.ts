import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { runQueue, MAX_CONCURRENT_TASKS } from '../src/task-scheduler.ts';
import { loadTaskSpec } from '../src/spec-loader.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import type { TaskSpec, FinalStatus } from '../src/types.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { createWorktree, removeWorktree, commitAll } from '../src/infra/git-manager.ts';

/** Flush the microtask + timer queue so pending workers make progress. */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** A bare TaskSpec — only the fields the pool reads (slug/branch) need to be real. */
function mkTask(slug: string): TaskSpec {
  return { slug, branch: `feat/${slug}`, subtasks: [], dir: `/tmp/${slug}` };
}

describe('parallel: task-pool concurrency', () => {
  test('N is a script-level constant of 2', () => {
    expect(MAX_CONCURRENT_TASKS).toBe(2);
  });

  test('given 3 tasks and N=2, at most 2 run at once; the third starts when a slot frees', async () => {
    let active = 0;
    let maxActive = 0;
    const claimed: string[] = [];
    const gates = new Map<string, () => void>();

    const runTaskFake = async (task: TaskSpec) => {
      claimed.push(task.slug);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => gates.set(task.slug, resolve));
      active--;
    };

    const done = runQueue([mkTask('a'), mkTask('b'), mkTask('c')], {
      concurrency: 2,
      runTask: runTaskFake,
    });

    await tick();
    expect(active).toBe(2);
    expect(claimed).toEqual(['a', 'b']); // c is queued, not started

    gates.get('a')!(); // free a slot
    await tick();
    expect(claimed).toEqual(['a', 'b', 'c']); // c took the freed slot
    expect(active).toBe(2);

    gates.get('b')!();
    gates.get('c')!();
    await done;

    expect(maxActive).toBe(2); // cap never exceeded
    expect(active).toBe(0); // queue fully drained
  });

  test('queue ordering is deterministic: tasks are claimed in input order', async () => {
    const claimed: string[] = [];
    const tasks = ['a', 'b', 'c', 'd', 'e'].map(mkTask);

    await runQueue(tasks, {
      concurrency: 2,
      runTask: async task => {
        claimed.push(task.slug);
      },
    });

    expect(claimed).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a task that fails to start frees its slot for the next task', async () => {
    const completed: string[] = [];

    await runQueue([mkTask('a'), mkTask('b'), mkTask('c')], {
      concurrency: 2,
      runTask: async task => {
        if (task.slug === 'a') throw new Error('container failed to start');
        completed.push(task.slug);
      },
    });

    // 'a' threw but the pool drained the rest rather than aborting.
    expect(completed.sort()).toEqual(['b', 'c']);
  });

  test('fewer tasks than slots still drains cleanly', async () => {
    const completed: string[] = [];
    await runQueue([mkTask('only')], {
      concurrency: 2,
      runTask: async task => {
        completed.push(task.slug);
      },
    });
    expect(completed).toEqual(['only']);
  });

  test('an empty queue resolves immediately', async () => {
    await expect(runQueue([], { runTask: async () => {} })).resolves.toBeUndefined();
  });
});

// ── End-to-end: real git worktrees + real SQLite (WAL) under concurrency ────────────

function ndjson(status: FinalStatus, summary = ''): string {
  return JSON.stringify({ type: 'final_result', status, summary });
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode: proc.exitCode ?? 1, stdout: stdout.trim() };
}

/**
 * Engine deps backed by real git worktrees/commits but a fake container+harness.
 * Each "container" is bound to its task's worktree; the fake harness writes a
 * file unique to that worktree (so there's something real to commit and any
 * cross-contamination would be visible), and `verify` runs for real in the
 * worktree. This exercises the slice's isolation-under-concurrency claims
 * (distinct worktrees, distinct branches, no commit cross-contamination) and the
 * concurrent SQLite writes, without Docker.
 */
function makeGitDeps(): EngineDeps {
  // containerId → bound worktree path, so exec calls act on the right checkout.
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
    commitAll,
    diffChanges: async () => '',
    execInContainer: async (cid, cmd, _env, _stdin): Promise<ExecResult> => {
      const wt = wtByContainer.get(cid)!;
      if (cmd[0] === 'pi') {
        // Agent edits the worktree: leave a file so the engine has a real commit.
        writeFileSync(join(wt, 'work.txt'), `done in ${wt}\n`);
        return { exitCode: 0, stdout: ndjson('passed', 'ok'), stderr: '' };
      }
      if (cmd[0] === 'cat') return { exitCode: 1, stdout: '', stderr: 'no file' };
      if (cmd[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      // verify (`sh -c <verify>`): run in the worktree so it reflects real state.
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

describe('parallel: isolation & SQLite under concurrency', () => {
  let repo: string;
  let wtBase: string;
  let dbPath: string;

  beforeEach(async () => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    repo = join(tmpdir(), `pi-par-repo-${stamp}`);
    wtBase = join(tmpdir(), `pi-par-wt-${stamp}`);
    dbPath = join(tmpdir(), `pi-par-${stamp}.db`);
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

  /** Create a task spec dir under the repo so its worktree branches off `main`. */
  function writeTaskSpec(slug: string): TaskSpec {
    const dir = join(repo, '.specs', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `---\nslug: ${slug}\nbranch: feat/${slug}\n---\n`, 'utf-8');
    // Each subtask creates a file unique to its task so cross-contamination is detectable.
    writeFileSync(
      join(dir, '01-work.md'),
      `---\nslug: work\nverify: 'true'\n---\nbody ${slug}\n`,
      'utf-8'
    );
    return loadTaskSpec(dir);
  }

  test('3 concurrent tasks land commits on their own branches; SQLite stays consistent (WAL)', async () => {
    const tasks = ['t1', 't2', 't3'].map(writeTaskSpec);
    const db = openDb(dbPath);
    const deps = makeGitDeps();

    await runQueue(tasks, {
      concurrency: MAX_CONCURRENT_TASKS,
      runTask: task =>
        runTask(task, { repoPath: repo, apiKey: 'k', db, deps, worktreesDir: wtBase, attemptTimeoutMs: 500 }),
    });

    // Every task committed exactly its own checkpoint on its own branch.
    const taskRepo = new TaskRepository(db);
    const subRepo = new SubtaskRepository(db);
    for (const slug of ['t1', 't2', 't3']) {
      const log = (await git(['log', '--oneline', `feat/${slug}`], repo)).stdout;
      expect(log).toContain(`${slug}(work): passed`);
      // No other task's checkpoint leaked onto this branch.
      for (const other of ['t1', 't2', 't3']) {
        if (other !== slug) expect(log).not.toContain(`${other}(work): passed`);
      }
      // Status writes from all concurrent tasks are intact and uncorrupted.
      const taskId = taskRepo.upsert(slug, `feat/${slug}`);
      expect(subRepo.getStatus(subRepo.findId(taskId, 'work'))).toBe('passed');
    }

    db.close();
  });
});
