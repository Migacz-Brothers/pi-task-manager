import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec, SpecLoadError } from '../src/spec-loader.ts';
import {
  schedule,
  topologicalOrder,
  findCycle,
  GraphCycleError,
  type GraphNode,
} from '../src/scheduler.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import type { FinalResult, FinalStatus, SubtaskStatus } from '../src/types.ts';

// ── Spec Loader: graph validation ───────────────────────────────────────────────

describe('graph: spec-loader validation', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `pi-graph-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    write('README.md', `---\nslug: t\nbranch: feat/t\n---\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string) {
    writeFileSync(join(dir, rel), content, 'utf-8');
  }

  /** A subtask file with optional `blockedBy`. */
  function sub(slug: string, blockedBy: string[] = []) {
    const dep = blockedBy.length ? `blockedBy: [${blockedBy.join(', ')}]\n` : '';
    return `---\nslug: ${slug}\nverify: 'true'\n${dep}---\nbody ${slug}\n`;
  }

  test('a valid acyclic graph loads and preserves declared dependencies', () => {
    write('01-a.md', sub('a'));
    write('02-b.md', sub('b', ['a']));
    write('03-c.md', sub('c', ['a', 'b']));

    const task = loadTaskSpec(dir);

    expect(task.subtasks.map(s => s.slug)).toEqual(['a', 'b', 'c']);
    expect(task.subtasks.find(s => s.slug === 'c')!.blockedBy).toEqual(['a', 'b']);
  });

  test('an unknown blockedBy slug is a hard load error', () => {
    write('01-a.md', sub('a', ['ghost']));

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
    expect(() => loadTaskSpec(dir)).toThrow(/unknown slug 'ghost'/);
  });

  test('a duplicate slug is a hard load error', () => {
    write('01-a.md', sub('dup'));
    write('02-b.md', sub('dup'));

    expect(() => loadTaskSpec(dir)).toThrow(/duplicate slug 'dup'/);
  });

  test('a self-referential blockedBy is rejected as a cycle', () => {
    write('01-a.md', sub('a', ['a']));

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
    expect(() => loadTaskSpec(dir)).toThrow(/cycle/i);
  });

  test('a multi-node cycle is rejected', () => {
    write('01-a.md', sub('a', ['c']));
    write('02-b.md', sub('b', ['a']));
    write('03-c.md', sub('c', ['b']));

    expect(() => loadTaskSpec(dir)).toThrow(/cycle/i);
  });
});

// ── Scheduler: pure topological order ────────────────────────────────────────────

describe('graph: topological order', () => {
  test('independent nodes keep input (NN-) order', () => {
    const nodes: GraphNode[] = [
      { slug: 'a', blockedBy: [] },
      { slug: 'b', blockedBy: [] },
      { slug: 'c', blockedBy: [] },
    ];
    expect(topologicalOrder(nodes)).toEqual(['a', 'b', 'c']);
  });

  test('a dependency is ordered before its dependent even against NN- order', () => {
    // `d` sorts first by filename but depends on `a`, which must run first.
    const nodes: GraphNode[] = [
      { slug: 'd', blockedBy: ['a'] },
      { slug: 'a', blockedBy: [] },
    ];
    expect(topologicalOrder(nodes)).toEqual(['a', 'd']);
  });

  test('NN- input order breaks ties among simultaneously-ready nodes', () => {
    // b and c both depend only on a; once a is done they are both ready and
    // must come out in input order.
    const nodes: GraphNode[] = [
      { slug: 'a', blockedBy: [] },
      { slug: 'b', blockedBy: ['a'] },
      { slug: 'c', blockedBy: ['a'] },
    ];
    expect(topologicalOrder(nodes)).toEqual(['a', 'b', 'c']);
  });

  test('findCycle returns a closed path; topologicalOrder throws on a cycle', () => {
    const cyclic: GraphNode[] = [
      { slug: 'a', blockedBy: ['b'] },
      { slug: 'b', blockedBy: ['a'] },
    ];
    const cycle = findCycle(cyclic);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]); // closed loop
    expect(() => topologicalOrder(cyclic)).toThrow(GraphCycleError);
  });
});

// ── Scheduler: runnable set & blocked cascade ────────────────────────────────────

describe('graph: schedule decisions', () => {
  const st = (pairs: Record<string, SubtaskStatus>) =>
    new Map<string, SubtaskStatus>(Object.entries(pairs));

  test('a subtask is runnable only once every dependency has passed', () => {
    const nodes: GraphNode[] = [
      { slug: 'a', blockedBy: [] },
      { slug: 'b', blockedBy: ['a'] },
    ];

    // a pending → only a runnable, b waits (neither runnable nor blocked).
    let d = schedule(nodes, st({ a: 'pending', b: 'pending' }));
    expect(d.runnable).toEqual(['a']);
    expect(d.blocked).toEqual([]);

    // a passed → b becomes runnable.
    d = schedule(nodes, st({ a: 'passed', b: 'pending' }));
    expect(d.runnable).toEqual(['b']);
  });

  test('a non-passed dependency cascades blocked to its transitive dependents', () => {
    // chain a -> b -> c -> d
    const nodes: GraphNode[] = [
      { slug: 'a', blockedBy: [] },
      { slug: 'b', blockedBy: ['a'] },
      { slug: 'c', blockedBy: ['b'] },
      { slug: 'd', blockedBy: ['c'] },
    ];

    const d = schedule(nodes, st({ a: 'verify_failed', b: 'pending', c: 'pending', d: 'pending' }));

    expect(d.blocked.sort()).toEqual(['b', 'c', 'd']); // full transitive closure
    expect(d.runnable).toEqual([]);
  });

  test('harness_error on a dependency also cascades', () => {
    const nodes: GraphNode[] = [
      { slug: 'a', blockedBy: [] },
      { slug: 'b', blockedBy: ['a'] },
    ];
    const d = schedule(nodes, st({ a: 'harness_error', b: 'pending' }));
    expect(d.blocked).toEqual(['b']);
  });

  test('diamond: a dependent is blocked when either parent fails, runnable when both pass', () => {
    //     a
    //    / \
    //   b   c
    //    \ /
    //     e
    const nodes: GraphNode[] = [
      { slug: 'a', blockedBy: [] },
      { slug: 'b', blockedBy: ['a'] },
      { slug: 'c', blockedBy: ['a'] },
      { slug: 'e', blockedBy: ['b', 'c'] },
    ];

    // one parent failed → e blocked, not runnable
    let d = schedule(nodes, st({ a: 'passed', b: 'passed', c: 'verify_failed', e: 'pending' }));
    expect(d.blocked).toEqual(['e']);
    expect(d.runnable).toEqual([]);

    // both parents passed → e runnable
    d = schedule(nodes, st({ a: 'passed', b: 'passed', c: 'passed', e: 'pending' }));
    expect(d.runnable).toEqual(['e']);
    expect(d.blocked).toEqual([]);
  });

  test('runnable is emitted in topological order', () => {
    const nodes: GraphNode[] = [
      { slug: 'a', blockedBy: [] },
      { slug: 'b', blockedBy: [] },
    ];
    expect(schedule(nodes, st({ a: 'pending', b: 'pending' })).runnable).toEqual(['a', 'b']);
  });
});

// ── Engine: scheduler-driven execution ───────────────────────────────────────────

function ndjson(status: FinalStatus, summary = ''): string {
  return JSON.stringify({ type: 'final_result', status, summary });
}

interface FakeRig {
  deps: EngineDeps;
  commits: string[];
  harnessBodies: string[];
}

function makeRig(harnessByBody: Record<string, FinalResult> = {}): FakeRig {
  const commits: string[] = [];
  const harnessBodies: string[] = [];

  const deps: EngineDeps = {
    ensureBranch: async () => {},
    startContainer: async () => 'fake-container',
    stopContainer: async () => {},
    commitAll: async (_repo, message) => {
      commits.push(message);
    },
    execInContainer: async (_cid, cmd, _env, stdin): Promise<ExecResult> => {
      if (cmd[0] === 'pi') {
        harnessBodies.push(stdin ?? '');
        const r = harnessByBody[stdin ?? ''] ?? { status: 'passed', summary: 'ok' };
        return { exitCode: 0, stdout: ndjson(r.status, r.summary), stderr: '' };
      }
      const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode: proc.exitCode ?? 1, stdout: out, stderr: err };
    },
  };

  return { deps, commits, harnessBodies };
}

describe('graph: engine wiring', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dir = join(tmpdir(), `pi-graph-eng-${stamp}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(tmpdir(), `pi-graph-eng-${stamp}.db`);
    writeFileSync(join(dir, 'README.md'), `---\nslug: t\nbranch: feat/t\n---\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  function writeSub(file: string, slug: string, opts: { verify?: string; blockedBy?: string[] } = {}) {
    const verify = opts.verify ?? 'true';
    const dep = opts.blockedBy?.length ? `blockedBy: [${opts.blockedBy.join(', ')}]\n` : '';
    writeFileSync(
      join(dir, file),
      `---\nslug: ${slug}\nverify: '${verify}'\n${dep}---\nbody ${slug}\n`,
      'utf-8'
    );
  }

  function statusOf(db: ReturnType<typeof openDb>, slug: string): SubtaskStatus {
    const tasks = new TaskRepository(db);
    const subs = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'feat/t');
    return subs.getStatus(subs.findId(taskId, slug));
  }

  test('subtasks run in topological order even when it contradicts NN- order', async () => {
    // File order is d, a, b but the graph forces a -> b -> d.
    writeSub('01-d.md', 'd', { blockedBy: ['b'] });
    writeSub('02-a.md', 'a');
    writeSub('03-b.md', 'b', { blockedBy: ['a'] });
    const db = openDb(dbPath);
    const rig = makeRig();

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(rig.harnessBodies).toEqual(['body a', 'body b', 'body d']);
    expect(rig.commits).toEqual(['t(a): passed', 't(b): passed', 't(d): passed']);
    db.close();
  });

  test('a subtask runs only after its blockedBy dependency has passed', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b', { blockedBy: ['a'] });
    const db = openDb(dbPath);
    const rig = makeRig();

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    // a ran (and committed) strictly before b.
    expect(rig.harnessBodies).toEqual(['body a', 'body b']);
    expect(statusOf(db, 'a')).toBe('passed');
    expect(statusOf(db, 'b')).toBe('passed');
    db.close();
  });

  test('a failed dependency cascades blocked to all transitive dependents', async () => {
    // a -> b -> c, and b's verify fails.
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b', { verify: 'false', blockedBy: ['a'] });
    writeSub('03-c.md', 'c', { blockedBy: ['b'] });
    const db = openDb(dbPath);
    const rig = makeRig();

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(statusOf(db, 'a')).toBe('passed');
    expect(statusOf(db, 'b')).toBe('verify_failed');
    expect(statusOf(db, 'c')).toBe('blocked'); // cascaded — never ran on a broken base
    expect(rig.harnessBodies).toEqual(['body a', 'body b']); // c never ran
    expect(rig.commits).toEqual(['t(a): passed']);
    db.close();
  });

  test('a harness error on a dependency blocks its dependents', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b', { blockedBy: ['a'] });
    const db = openDb(dbPath);
    const rig = makeRig({ 'body a': { status: 'harness_error', summary: 'boom' } });

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(statusOf(db, 'a')).toBe('harness_error');
    expect(statusOf(db, 'b')).toBe('blocked');
    expect(rig.commits).toEqual([]);
    db.close();
  });

  test('diamond: a failing branch blocks the join while the other branch still ran', async () => {
    //     a
    //    / \
    //   b   c(fails)
    //    \ /
    //     e
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b', { blockedBy: ['a'] });
    writeSub('03-c.md', 'c', { verify: 'false', blockedBy: ['a'] });
    writeSub('04-e.md', 'e', { blockedBy: ['b', 'c'] });
    const db = openDb(dbPath);
    const rig = makeRig();

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(statusOf(db, 'a')).toBe('passed');
    expect(statusOf(db, 'b')).toBe('passed');
    expect(statusOf(db, 'c')).toBe('verify_failed');
    expect(statusOf(db, 'e')).toBe('blocked'); // one failed parent is enough
    db.close();
  });
});
