import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec } from '../src/spec-loader.ts';
import {
  openDb,
  TaskRepository,
  SubtaskRepository,
  CommandRepository,
  EventRepository,
} from '../src/infra/db/index.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import type { FinalResult, SubtaskStatus } from '../src/types.ts';

function ndjson(r: FinalResult): string {
  return JSON.stringify({ type: 'final_result', status: r.status, summary: r.summary });
}

interface RigCfg {
  /** Outcome per pi (harness) call; default = passed. */
  harness?: (prompt: string, callIndex: number) => FinalResult;
  /** Exit/output per in-container verify (`sh -c`) call. */
  verify?: (callIndex: number) => { exitCode: number; stdout?: string };
  /** Exit/output per host verify (`execHost`, used by hitl approve). */
  hostVerify?: (callIndex: number) => { exitCode: number; stdout?: string; stderr?: string };
  diff?: string;
}

function makeRig(cfg: RigCfg = {}) {
  const harnessPrompts: string[] = [];
  const commits: Array<{ message: string; allowEmpty: boolean }> = [];
  const removed: string[] = [];
  const hostVerifyCmds: string[][] = [];
  const counts = { starts: 0, stops: 0, verify: 0, hostVerify: 0 };

  const deps: EngineDeps = {
    createWorktree: async () => {},
    removeWorktree: async (_repo, wt) => {
      removed.push(wt);
    },
    resolveImage: async () => 'fake-image',
    startContainer: async () => {
      counts.starts++;
      return 'fake-container';
    },
    stopContainer: async () => {
      counts.stops++;
    },
    commitAll: async (_repo, message, allowEmpty) => {
      commits.push({ message, allowEmpty: !!allowEmpty });
    },
    diffChanges: async () => cfg.diff ?? '',
    execHost: async (cwd, cmd): Promise<ExecResult> => {
      hostVerifyCmds.push(cmd);
      const idx = counts.hostVerify++;
      const v = cfg.hostVerify?.(idx) ?? { exitCode: 0 };
      return { exitCode: v.exitCode, stdout: v.stdout ?? '', stderr: v.stderr ?? '' };
    },
    execInContainer: async (_cid, cmd, _env, stdin): Promise<ExecResult> => {
      if (cmd[0] === 'pi') {
        const idx = harnessPrompts.length;
        harnessPrompts.push(stdin ?? '');
        const r = cfg.harness?.(stdin ?? '', idx) ?? { status: 'passed', summary: 'ok' };
        return { exitCode: 0, stdout: ndjson(r), stderr: '' };
      }
      if (cmd[0] === 'cat') return { exitCode: 1, stdout: '', stderr: 'no such file' };
      if (cmd[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      // in-container verify: `sh -c <cmd>`
      const idx = counts.verify++;
      const v = cfg.verify?.(idx) ?? { exitCode: 0 };
      return { exitCode: v.exitCode, stdout: v.stdout ?? '', stderr: '' };
    },
  };

  return { deps, harnessPrompts, commits, removed, hostVerifyCmds, counts };
}

describe('hitl: command bus + human-in-the-loop', () => {
  let dir: string;
  let dbPath: string;
  let wtBase: string;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dir = join(tmpdir(), `pi-hitl-${stamp}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(tmpdir(), `pi-hitl-${stamp}.db`);
    wtBase = join(tmpdir(), `pi-hitl-wt-${stamp}`);
    writeFileSync(join(dir, 'README.md'), `---\nslug: t\nbranch: feat/t\n---\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  interface SubOpts {
    verify?: string;
    hitl?: boolean;
    blockedBy?: string[];
    body?: string;
  }
  function writeSub(file: string, slug: string, o: SubOpts = {}) {
    const lines = [`slug: ${slug}`, `verify: '${o.verify ?? 'true'}'`];
    if (o.hitl) lines.push('hitl: true');
    if (o.blockedBy?.length) lines.push(`blockedBy: [${o.blockedBy.join(', ')}]`);
    writeFileSync(
      join(dir, file),
      `---\n${lines.join('\n')}\n---\n${o.body ?? `body ${slug}`}\n`,
      'utf-8'
    );
  }

  function repos(db: ReturnType<typeof openDb>) {
    const tasks = new TaskRepository(db);
    const subs = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'feat/t');
    return { tasks, subs, taskId, cmds: new CommandRepository(db), events: new EventRepository(db) };
  }
  function statusOf(db: ReturnType<typeof openDb>, slug: string): SubtaskStatus {
    const { subs, taskId } = repos(db);
    return subs.getStatus(subs.findId(taskId, slug));
  }
  function run(rig: ReturnType<typeof makeRig>, db: ReturnType<typeof openDb>) {
    return runTask(loadTaskSpec(dir), {
      repoPath: dir,
      apiKey: 'k',
      db,
      deps: rig.deps,
      attemptTimeoutMs: 200,
      worktreesDir: wtBase,
    });
  }

  test('a hitl subtask pauses with no container/harness and surfaces its instructions', async () => {
    writeSub('01-a.md', 'a', { hitl: true, body: 'Rotate the prod API key, then approve.' });
    const db = openDb(dbPath);
    const rig = makeRig();

    await run(rig, db); // no command queued → pauses and returns

    expect(statusOf(db, 'a')).toBe('needs_human');
    expect(rig.counts.starts).toBe(0); // no container for a pure-hitl task
    expect(rig.harnessPrompts).toHaveLength(0); // no harness
    expect(rig.removed).toEqual([]); // worktree kept for the human

    const { events } = repos(db);
    const pause = events.list('t').find(e => e.type === 'needs_human:hitl');
    expect(pause?.detail).toContain('Rotate the prod API key');
    db.close();
  });

  test('approve runs the host verify, commits (empty allowed), and continues to dependents', async () => {
    writeSub('01-a.md', 'a', { hitl: true, verify: 'true' });
    writeSub('02-b.md', 'b', { blockedBy: ['a'] }); // agent-backed dependent
    const db = openDb(dbPath);
    const rig = makeRig();

    repos(db).cmds.enqueue('t', 'a', 'approve');
    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('passed');
    expect(statusOf(db, 'b')).toBe('passed'); // dependent ran after approval

    // The hitl verify ran on the host, not in the container.
    expect(rig.counts.hostVerify).toBe(1);
    // The approve commit is empty-allowed; b's commit is the normal one.
    const approveCommit = rig.commits.find(c => c.message.includes('(a): approved'));
    expect(approveCommit?.allowEmpty).toBe(true);
    expect(rig.commits.some(c => c.message.includes('(b): passed'))).toBe(true);
    db.close();
  });

  test('retry with a note re-runs a failed subtask with the note in the assembled context', async () => {
    writeSub('01-a.md', 'a'); // agent-backed
    const db = openDb(dbPath);
    // verify always red → escalates to needs_human on each run.
    const rig = makeRig({ verify: () => ({ exitCode: 1, stdout: 'still red' }) });

    repos(db).cmds.enqueue('t', 'a', 'retry', 'The fixture lives in tests/data, not src.');
    await run(rig, db);

    // The first run's two attempts used the raw/auto prompts; the post-retry re-run
    // folds in the human note.
    const noted = rig.harnessPrompts.find(p =>
      p.includes('The fixture lives in tests/data, not src.')
    );
    expect(noted).toBeDefined();
    expect(noted).toContain('body a'); // goal carried forward
    expect(rig.harnessPrompts.length).toBeGreaterThan(2); // a fresh re-run happened
    db.close();
  });

  test('skip marks the subtask skipped and cascades blocked to dependents', async () => {
    writeSub('01-a.md', 'a', { verify: 'false' }); // fails → needs_human
    writeSub('02-b.md', 'b', { blockedBy: ['a'] });
    const db = openDb(dbPath);
    const rig = makeRig({ verify: () => ({ exitCode: 1 }) });

    repos(db).cmds.enqueue('t', 'a', 'skip');
    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('skipped');
    expect(statusOf(db, 'b')).toBe('blocked'); // a skip does not satisfy blockedBy
    expect(rig.removed).toEqual([]); // unfinished work → worktree kept
    db.close();
  });

  test('abort stops the task and keeps the worktree + branch', async () => {
    writeSub('01-a.md', 'a', { verify: 'false' });
    const db = openDb(dbPath);
    const rig = makeRig({ verify: () => ({ exitCode: 1 }) });

    repos(db).cmds.enqueue('t', 'a', 'abort');
    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('needs_human'); // left paused
    expect(rig.removed).toEqual([]); // worktree kept
    expect(rig.counts.stops).toBe(1); // container torn down
    const { tasks, taskId, events } = repos(db);
    expect(tasks.findById(taskId)?.status).toBe('aborted');
    expect(events.list('t').some(e => e.type === 'command:abort')).toBe(true);
    db.close();
  });

  test('a command is consumed exactly once and recorded in the event history', async () => {
    writeSub('01-a.md', 'a', { hitl: true });
    const db = openDb(dbPath);
    const rig = makeRig();

    const { cmds, events } = repos(db);
    const id = cmds.enqueue('t', 'a', 'approve');
    await run(rig, db);

    // Consumed: no longer pending, and a second consume() is a no-op.
    expect(cmds.nextPending('t', 'a')).toBeNull();
    expect(cmds.consume(id)).toBe(false);
    // Recorded exactly once.
    const applied = events.list('t').filter(e => e.type === 'command:approve');
    expect(applied).toHaveLength(1);
    db.close();
  });

  test('retry is rejected as an action for a hitl subtask (no agent run to retry)', async () => {
    writeSub('01-a.md', 'a', { hitl: true });
    const db = openDb(dbPath);
    const rig = makeRig();

    repos(db).cmds.enqueue('t', 'a', 'retry', 'try harder');
    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('needs_human'); // still paused, not resolved
    expect(rig.harnessPrompts).toHaveLength(0); // no harness ever ran
    expect(rig.counts.starts).toBe(0);
    const { events } = repos(db);
    expect(events.list('t').some(e => e.type === 'command_rejected:retry')).toBe(true);
    db.close();
  });

  test('two commands queued for one subtask are applied deterministically in order', async () => {
    writeSub('01-a.md', 'a'); // agent-backed, verify always red
    const db = openDb(dbPath);
    const rig = makeRig({ verify: () => ({ exitCode: 1 }) });

    const { cmds, events } = repos(db);
    cmds.enqueue('t', 'a', 'retry'); // issued first → applied first
    cmds.enqueue('t', 'a', 'skip'); // issued second → applied after the retry re-fails

    await run(rig, db);

    // retry re-ran the subtask; when it failed again, skip resolved the pause.
    expect(statusOf(db, 'a')).toBe('skipped');
    const order = events
      .list('t')
      .map(e => e.type)
      .filter(t => t === 'command:retry' || t === 'command:skip');
    expect(order).toEqual(['command:retry', 'command:skip']);
    db.close();
  });
});
