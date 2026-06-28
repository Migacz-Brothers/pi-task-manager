import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec } from '../src/spec-loader.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infrastructure/db/index.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import type { FinalResult, FinalStatus } from '../src/types.ts';

// ── Spec Loader: ordering & reconciliation ──────────────────────────────────────

describe('sequence: spec-loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `pi-seq-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    write('README.md', `---\nslug: t\nbranch: feat/t\n---\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string) {
    writeFileSync(join(dir, rel), content, 'utf-8');
  }

  function sub(slug: string, verify = 'true', body = `body ${slug}`) {
    return `---\nslug: ${slug}\nverify: '${verify}'\n---\n${body}\n`;
  }

  test('orders subtasks by NN- prefix regardless of write order', () => {
    write('03-c.md', sub('c'));
    write('01-a.md', sub('a'));
    write('02-b.md', sub('b'));

    const task = loadTaskSpec(dir);

    expect(task.subtasks.map(s => s.slug)).toEqual(['a', 'b', 'c']);
  });

  test('duplicate NN- prefixes break ties deterministically by filename', () => {
    write('01-zebra.md', sub('zebra'));
    write('01-apple.md', sub('apple'));
    write('01-mango.md', sub('mango'));

    const task = loadTaskSpec(dir);

    // tie on prefix `01-` → ordered by the rest of the filename
    expect(task.subtasks.map(s => s.slug)).toEqual(['apple', 'mango', 'zebra']);
  });

  test('each subtask file gets its own content hash', () => {
    write('01-a.md', sub('a', 'true', 'distinct body A'));
    write('02-b.md', sub('b', 'true', 'distinct body B'));

    const task = loadTaskSpec(dir);

    expect(task.subtasks[0].contentHash).not.toBe(task.subtasks[1].contentHash);
  });

  test('editing a file changes its content hash', () => {
    write('01-a.md', sub('a', 'true', 'before'));
    const before = loadTaskSpec(dir).subtasks[0].contentHash;

    write('01-a.md', sub('a', 'true', 'after'));
    const after = loadTaskSpec(dir).subtasks[0].contentHash;

    expect(after).not.toBe(before);
  });

  test('added / removed subtask files are reflected on reload', () => {
    write('01-a.md', sub('a'));
    expect(loadTaskSpec(dir).subtasks.map(s => s.slug)).toEqual(['a']);

    write('02-b.md', sub('b'));
    expect(loadTaskSpec(dir).subtasks.map(s => s.slug)).toEqual(['a', 'b']);

    rmSync(join(dir, '01-a.md'));
    expect(loadTaskSpec(dir).subtasks.map(s => s.slug)).toEqual(['b']);
  });
});

// ── State store: re-seed on drift & orphan reconciliation ────────────────────────

describe('sequence: state-store drift', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `pi-seq-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  test('unchanged content hash preserves status and attempts', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'b');
    const id = subtasks.upsert(taskId, 's', 'echo ok', 'hash-1');

    subtasks.incrementAttempts(id);
    subtasks.setStatus(id, 'passed');

    subtasks.upsert(taskId, 's', 'echo ok', 'hash-1'); // same hash

    expect(subtasks.getStatus(id)).toBe('passed');
    expect(subtasks.findById(id)?.attempts).toBe(1);
    db.close();
  });

  test('changed content hash re-seeds: status -> pending, attempts -> 0', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'b');
    const id = subtasks.upsert(taskId, 's', 'echo ok', 'hash-1');

    subtasks.incrementAttempts(id);
    subtasks.setStatus(id, 'passed');

    subtasks.upsert(taskId, 's', 'echo CHANGED', 'hash-2'); // drift

    expect(subtasks.getStatus(id)).toBe('pending');
    expect(subtasks.findById(id)?.attempts).toBe(0);
    expect(subtasks.findById(id)?.verify).toBe('echo CHANGED');
    db.close();
  });

  test('deleteOrphans removes rows whose slug is not retained', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'b');
    subtasks.upsert(taskId, 'a', 'true', 'h-a');
    const bId = subtasks.upsert(taskId, 'b', 'true', 'h-b');
    subtasks.upsert(taskId, 'c', 'true', 'h-c');

    const pruned = subtasks.deleteOrphans(taskId, ['a', 'c']);

    expect(pruned).toBe(1);
    expect(() => subtasks.findId(taskId, 'b')).toThrow();
    expect(subtasks.findById(bId)).toBeNull();
    expect(subtasks.findId(taskId, 'a')).toBeGreaterThan(0);
    expect(subtasks.findId(taskId, 'c')).toBeGreaterThan(0);
    db.close();
  });

  test('deleteOrphans with empty keep-set clears the task', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'b');
    subtasks.upsert(taskId, 'a', 'true', 'h-a');
    subtasks.upsert(taskId, 'b', 'true', 'h-b');

    expect(subtasks.deleteOrphans(taskId, [])).toBe(2);
    db.close();
  });

  test('deleteOrphans does not touch sibling tasks', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const t1 = tasks.upsert('t1', 'b1');
    const t2 = tasks.upsert('t2', 'b2');
    subtasks.upsert(t1, 'a', 'true', 'h');
    subtasks.upsert(t2, 'a', 'true', 'h');

    subtasks.deleteOrphans(t1, []); // wipe t1 only

    expect(subtasks.findId(t2, 'a')).toBeGreaterThan(0);
    db.close();
  });
});

// ── Engine: sequential execution, commits, halting, resume ───────────────────────

function ndjson(status: FinalStatus, summary = ''): string {
  return JSON.stringify({ type: 'final_result', status, summary });
}

interface FakeRig {
  deps: EngineDeps;
  commits: string[];
  harnessBodies: string[];
  counts: { started: number; stopped: number };
}

/** Build engine deps backed by fakes; verify commands run for real via `sh -c`. */
function makeRig(harnessByBody: Record<string, FinalResult> = {}): FakeRig {
  const commits: string[] = [];
  const harnessBodies: string[] = [];
  const counts = { started: 0, stopped: 0 };

  const deps: EngineDeps = {
    ensureBranch: async () => {},
    startContainer: async () => {
      counts.started++;
      return 'fake-container';
    },
    stopContainer: async () => {
      counts.stopped++;
    },
    commitAll: async (_repo, message) => {
      commits.push(message);
    },
    execInContainer: async (_cid, cmd, _env, stdin): Promise<ExecResult> => {
      if (cmd[0] === 'pi') {
        harnessBodies.push(stdin ?? '');
        const r = harnessByBody[stdin ?? ''] ?? { status: 'passed', summary: 'ok' };
        return { exitCode: 0, stdout: ndjson(r.status, r.summary), stderr: '' };
      }
      // verify: actually run the shell command so its exit code is real
      const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode: proc.exitCode ?? 1, stdout: out, stderr: err };
    },
  };

  return { deps, commits, harnessBodies, counts };
}

describe('sequence: engine', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dir = join(tmpdir(), `pi-seq-eng-${stamp}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(tmpdir(), `pi-seq-eng-${stamp}.db`);
    writeFileSync(join(dir, 'README.md'), `---\nslug: t\nbranch: feat/t\n---\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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

  test('N passing subtasks produce N commits in order', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b');
    writeSub('03-c.md', 'c');
    const db = openDb(dbPath);
    const rig = makeRig();

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(rig.commits).toEqual([
      't(a): passed',
      't(b): passed',
      't(c): passed',
    ]);
    expect(statusOf(db, 'a')).toBe('passed');
    expect(statusOf(db, 'c')).toBe('passed');
    expect(rig.counts.started).toBe(1);
    expect(rig.counts.stopped).toBe(1);
    db.close();
  });

  test('a failing verify halts the task and leaves later subtasks unrun', async () => {
    writeSub('01-a.md', 'a', 'true');
    writeSub('02-b.md', 'b', 'false'); // verify fails
    writeSub('03-c.md', 'c', 'true');
    const db = openDb(dbPath);
    const rig = makeRig();

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(rig.commits).toEqual(['t(a): passed']);
    expect(statusOf(db, 'a')).toBe('passed');
    expect(statusOf(db, 'b')).toBe('verify_failed');
    expect(statusOf(db, 'c')).toBe('pending'); // never ran
    expect(rig.harnessBodies).not.toContain('body c');
    expect(rig.counts.stopped).toBe(1); // container torn down even on halt
    db.close();
  });

  test('a harness failure halts the task', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b');
    writeSub('03-c.md', 'c');
    const db = openDb(dbPath);
    const rig = makeRig({ 'body b': { status: 'harness_error', summary: 'boom' } });

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(rig.commits).toEqual(['t(a): passed']);
    expect(statusOf(db, 'b')).toBe('harness_error');
    expect(statusOf(db, 'c')).toBe('pending');
    db.close();
  });

  test('a second run skips already-passed subtasks (no duplicate commits)', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b');
    const db = openDb(dbPath);

    const rig1 = makeRig();
    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig1.deps });
    expect(rig1.commits).toHaveLength(2);

    const rig2 = makeRig();
    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig2.deps });
    expect(rig2.commits).toHaveLength(0);
    expect(rig2.harnessBodies).toHaveLength(0); // nothing re-run
    db.close();
  });

  test('editing a subtask re-seeds it: only that subtask re-runs on the next run', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b');
    const db = openDb(dbPath);

    const rig1 = makeRig();
    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig1.deps });
    expect(rig1.commits).toHaveLength(2);

    // edit subtask b's body → its content hash drifts
    writeSub('02-b.md', 'b', 'true', 'body b EDITED');

    const rig2 = makeRig();
    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig2.deps });

    expect(rig2.harnessBodies).toEqual(['body b EDITED']); // a skipped, b re-run
    expect(rig2.commits).toEqual(['t(b): passed']);
    db.close();
  });

  test('a subtask file removed between runs is pruned from the store', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b');
    const db = openDb(dbPath);
    const rig1 = makeRig();
    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig1.deps });

    rmSync(join(dir, '02-b.md'));
    const rig2 = makeRig();
    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig2.deps });

    const tasks = new TaskRepository(db);
    const subs = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'feat/t');
    expect(() => subs.findId(taskId, 'b')).toThrow(); // reconciled away
    expect(subs.findId(taskId, 'a')).toBeGreaterThan(0);
    db.close();
  });

  test('the engine never writes status back into the .md files', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b');
    const before = {
      a: readFileSync(join(dir, '01-a.md'), 'utf-8'),
      b: readFileSync(join(dir, '02-b.md'), 'utf-8'),
    };
    const db = openDb(dbPath);
    const rig = makeRig();

    await runTask(loadTaskSpec(dir), { repoPath: dir, apiKey: 'k', db, deps: rig.deps });

    expect(readFileSync(join(dir, '01-a.md'), 'utf-8')).toBe(before.a);
    expect(readFileSync(join(dir, '02-b.md'), 'utf-8')).toBe(before.b);
    db.close();
  });
});
