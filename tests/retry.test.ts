import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec } from '../src/spec-loader.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import type { FinalResult } from '../src/types.ts';
import { assembleRetryPrompt } from '../src/context-assembler.ts';

// ── Context assembler: pure (inputs → prompt) ────────────────────────────────────

describe('retry: context assembler', () => {
  const base = { body: 'do the thing', attempt: 2, maxAttempts: 2 };

  test('folds in the failing verify output and the diff', () => {
    const prompt = assembleRetryPrompt({
      ...base,
      verifyOutput: 'FAIL: 3 tests red',
      diff: '--- a\n+++ b\n+broken',
    });
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('attempt 2 of 2');
    expect(prompt).toContain('FAIL: 3 tests red');
    expect(prompt).toContain('+broken');
  });

  test('includes the handoff fragment when present', () => {
    const prompt = assembleRetryPrompt({
      ...base,
      verifyOutput: 'red',
      diff: 'd',
      fragment: 'I got stuck on the parser',
    });
    expect(prompt).toContain('Handoff notes');
    expect(prompt).toContain('I got stuck on the parser');
  });

  test('omits the handoff section when there is no fragment (graceful degrade)', () => {
    const prompt = assembleRetryPrompt({ ...base, verifyOutput: 'red', diff: 'd' });
    expect(prompt).not.toContain('Handoff notes');
  });

  test('notes an empty diff instead of dropping the section', () => {
    const prompt = assembleRetryPrompt({ ...base, verifyOutput: 'red', diff: '' });
    expect(prompt).toContain('changed nothing on disk');
    expect(prompt).toContain('red'); // verify output still present
  });

  test('notes absent verify output instead of dropping the section', () => {
    const prompt = assembleRetryPrompt({ ...base, verifyOutput: '', diff: 'd' });
    expect(prompt).toContain('no verify output');
  });
});

// ── Engine: retry loop, classification, timeout, escalation ───────────────────────

function ndjson(r: FinalResult): string {
  return JSON.stringify({ type: 'final_result', status: r.status, summary: r.summary });
}

interface RigCfg {
  /** Outcome per pi call: a FinalResult, or 'hang' to never settle (until aborted). */
  harness?: (prompt: string, callIndex: number) => FinalResult | 'hang';
  /** Exit/output per verify (`sh -c`) call. */
  verify?: (callIndex: number) => { exitCode: number; stdout?: string; stderr?: string };
  diff?: string;
  /** Simulate the agent writing a handoff fragment during a given (1-based) attempt. */
  writeFragment?: { attempt: number; content: string };
}

function makeRig(cfg: RigCfg = {}) {
  const harnessPrompts: string[] = [];
  const commits: string[] = [];
  const state = { verifyCount: 0, catCount: 0, rmCount: 0, aborts: 0 };
  let fragment: string | undefined;

  const deps: EngineDeps = {
    createWorktree: async () => {},
    removeWorktree: async () => {},
    startContainer: async () => 'fake-container',
    stopContainer: async () => {},
    commitAll: async (_repo, message) => {
      commits.push(message);
    },
    diffChanges: async () => cfg.diff ?? '',
    execInContainer: async (_cid, cmd, _env, stdin, signal): Promise<ExecResult> => {
      if (cmd[0] === 'pi') {
        const idx = harnessPrompts.length;
        harnessPrompts.push(stdin ?? '');
        if (cfg.writeFragment && cfg.writeFragment.attempt === idx + 1) {
          fragment = cfg.writeFragment.content;
        }
        const decision = cfg.harness?.(stdin ?? '', idx) ?? { status: 'passed', summary: 'ok' };
        if (decision === 'hang') {
          return await new Promise<ExecResult>(resolve => {
            signal?.addEventListener(
              'abort',
              () => {
                state.aborts++;
                resolve({ exitCode: 137, stdout: '', stderr: 'killed' });
              },
              { once: true }
            );
          });
        }
        return { exitCode: 0, stdout: ndjson(decision), stderr: '' };
      }
      if (cmd[0] === 'cat') {
        state.catCount++;
        if (fragment === undefined) return { exitCode: 1, stdout: '', stderr: 'no such file' };
        return { exitCode: 0, stdout: fragment, stderr: '' };
      }
      if (cmd[0] === 'rm') {
        state.rmCount++;
        fragment = undefined;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      // verify: `sh -c <cmd>`
      const v = cfg.verify?.(state.verifyCount++) ?? { exitCode: 0 };
      return { exitCode: v.exitCode, stdout: v.stdout ?? '', stderr: v.stderr ?? '' };
    },
  };

  return {
    deps,
    commits,
    harnessPrompts,
    fragment: () => fragment,
    counts: state,
  };
}

describe('retry: engine', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dir = join(tmpdir(), `pi-retry-${stamp}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(tmpdir(), `pi-retry-${stamp}.db`);
    writeFileSync(join(dir, 'README.md'), `---\nslug: t\nbranch: feat/t\n---\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  function writeSub(file: string, slug: string, blockedBy?: string[]) {
    const dep = blockedBy?.length ? `blockedBy: [${blockedBy.join(', ')}]\n` : '';
    writeFileSync(
      join(dir, file),
      `---\nslug: ${slug}\nverify: 'true'\n${dep}---\nbody ${slug}\n`,
      'utf-8'
    );
  }

  function statusOf(db: ReturnType<typeof openDb>, slug: string) {
    const tasks = new TaskRepository(db);
    const subs = new SubtaskRepository(db);
    const taskId = tasks.upsert('t', 'feat/t');
    return subs.getStatus(subs.findId(taskId, slug));
  }

  function run(rig: ReturnType<typeof makeRig>, db: ReturnType<typeof openDb>) {
    return runTask(loadTaskSpec(dir), {
      repoPath: dir,
      apiKey: 'k',
      db,
      deps: rig.deps,
      attemptTimeoutMs: 200,
    });
  }

  test('a verify_failed attempt triggers a fresh retry carrying verify output + diff', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig({
      // agent always claims success; verify is red on both attempts
      harness: () => ({ status: 'passed', summary: 'all good!' }),
      verify: () => ({ exitCode: 1, stdout: 'FAILED: 2 assertions' }),
      diff: 'diff --git a/x b/x\n+regression',
    });

    await run(rig, db);

    expect(rig.harnessPrompts).toHaveLength(2); // a fresh second attempt happened
    expect(rig.harnessPrompts[0]).toBe('body a'); // first attempt is the raw body
    const retry = rig.harnessPrompts[1];
    expect(retry).toContain('body a'); // goal carried forward
    expect(retry).toContain('FAILED: 2 assertions'); // failing verify output
    expect(retry).toContain('+regression'); // diff of the attempt's changes
    db.close();
  });

  test('a fragment the agent wrote is included in the retry, then cleared', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig({
      harness: () => ({ status: 'passed', summary: 'done' }),
      verify: () => ({ exitCode: 1, stdout: 'red' }),
      writeFragment: { attempt: 1, content: 'NOTE: the API moved to v2' },
    });

    await run(rig, db);

    expect(rig.harnessPrompts[1]).toContain('NOTE: the API moved to v2');
    expect(rig.fragment()).toBeUndefined(); // cleared after being read
    expect(rig.counts.rmCount).toBeGreaterThanOrEqual(1);
    db.close();
  });

  test('a hung attempt is killed at the timeout and counted as harness_error', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig({ harness: () => 'hang' });

    await run(rig, db);

    expect(rig.counts.aborts).toBe(2); // both attempts timed out and were killed
    expect(rig.counts.verifyCount).toBe(0); // harness_error → verify never ran
    expect(rig.commits).toEqual([]);
    expect(statusOf(db, 'a')).toBe('needs_human');
    db.close();
  });

  test('after K=2 failed attempts the subtask is needs_human and the task halts', async () => {
    writeSub('01-a.md', 'a');
    writeSub('02-b.md', 'b', ['a']); // depends on a
    const db = openDb(dbPath);
    const rig = makeRig({ verify: c => ({ exitCode: c < 2 ? 1 : 0 }) }); // a fails twice

    await run(rig, db);

    expect(statusOf(db, 'a')).toBe('needs_human');
    expect(statusOf(db, 'b')).toBe('blocked'); // dependent cascaded, did not run
    expect(rig.harnessPrompts.some(p => p.includes('body b'))).toBe(false);
    expect(rig.commits).toEqual([]);
    db.close();
  });

  test('agent claims success but verify is red → recorded verify_failed (verify is authoritative)', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    // harness always claims success; verify red on attempt 1, green on attempt 2.
    const rig = makeRig({
      harness: () => ({ status: 'passed', summary: 'I finished everything' }),
      verify: c => ({ exitCode: c === 0 ? 1 : 0, stdout: c === 0 ? 'still red' : '' }),
    });

    await run(rig, db);

    // The claimed-success attempt did NOT pass: it retried, and the retry prompt
    // proves attempt 1 was treated as a failure.
    expect(rig.harnessPrompts).toHaveLength(2);
    expect(rig.harnessPrompts[1]).toContain('still red');
    // The second attempt's green verify is what actually passes it.
    expect(statusOf(db, 'a')).toBe('passed');
    expect(rig.commits).toEqual(['t(a): passed']);
    db.close();
  });

  test('edge: confident agent, red verify, no fragment → context still from verify + diff', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig({
      harness: () => ({ status: 'passed', summary: 'confident' }),
      verify: () => ({ exitCode: 1, stdout: 'compile error on line 9' }),
      diff: 'patch-without-handoff',
      // no writeFragment → agent left no handoff
    });

    await run(rig, db);

    const retry = rig.harnessPrompts[1];
    expect(retry).toContain('compile error on line 9');
    expect(retry).toContain('patch-without-handoff');
    expect(retry).not.toContain('Handoff notes');
    db.close();
  });

  test('edge: empty diff on failure → context still includes the verify output', async () => {
    writeSub('01-a.md', 'a');
    const db = openDb(dbPath);
    const rig = makeRig({
      verify: () => ({ exitCode: 1, stdout: 'nothing changed but still failing' }),
      diff: '', // agent changed nothing
    });

    await run(rig, db);

    const retry = rig.harnessPrompts[1];
    expect(retry).toContain('nothing changed but still failing');
    expect(retry).toContain('changed nothing on disk');
    db.close();
  });
});
