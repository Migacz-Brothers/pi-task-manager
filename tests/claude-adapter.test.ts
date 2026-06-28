import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec } from '../src/spec-loader.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { runTask } from '../src/engine.ts';
import type { EngineDeps } from '../src/engine.ts';
import type { ExecResult } from '../src/harness-adapter.ts';
import { parseEventStream, ENGINE_OWNS_GIT_INSTRUCTION } from '../src/harness-adapter.ts';
import {
  runClaudeHarness,
  parseClaudeEventStream,
  normalizeClaudeEvents,
} from '../src/claude-adapter.ts';
import { selectHarness, isHarness, DEFAULT_HARNESS } from '../src/harness-registry.ts';
import { runPiHarness } from '../src/harness-adapter.ts';
import { runClaudeHarness as registeredClaude } from '../src/claude-adapter.ts';
import type { HarnessEvent } from '../src/types.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

function tmp(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ── Normalization: Claude stream-json → common contract ───────────────────────

describe('claude-adapter: stream normalization', () => {
  test('maps a full success stream to the common contract', () => {
    const { events, result } = parseClaudeEventStream(fixture('claude-passed.ndjson'));

    expect(events.map(e => e.type)).toEqual([
      'task_started',
      'activity',
      'tool_use',
      'final_result',
    ]);
    expect(result).toEqual({ status: 'passed', summary: 'Added the helper; tests should pass.' });
  });

  test('system/init becomes task_started; other system subtypes are ignored', () => {
    expect(normalizeClaudeEvents({ type: 'system', subtype: 'init' })).toEqual([
      { type: 'task_started' },
    ]);
    expect(normalizeClaudeEvents({ type: 'system', subtype: 'compact_boundary' })).toEqual([]);
  });

  test('an assistant turn may yield several events in order', () => {
    const events = normalizeClaudeEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Editing two files.' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { path: 'b.ts' } },
        ],
      },
    });

    expect(events).toEqual([
      { type: 'activity', text: 'Editing two files.' },
      { type: 'tool_use', tool: 'Edit', input: { path: 'a.ts' } },
      { type: 'tool_use', tool: 'Edit', input: { path: 'b.ts' } },
    ]);
  });

  test('Claude-only events with no pi equivalent are dropped, not errors', () => {
    // tool_result (user), partial deltas, and empty text blocks all map cleanly.
    expect(normalizeClaudeEvents({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toEqual([]);
    expect(normalizeClaudeEvents({ type: 'stream_event', event: { type: 'content_block_delta' } })).toEqual([]);
    expect(normalizeClaudeEvents({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } })).toEqual([]);
    expect(normalizeClaudeEvents('garbage')).toEqual([]);
  });

  test('error_max_turns maps to harness_error', () => {
    const { result } = parseClaudeEventStream(fixture('claude-max-turns.ndjson'));
    expect(result.status).toBe('harness_error');
  });

  test('an is_error result is harness_error even with subtype success', () => {
    const { result } = parseClaudeEventStream(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'boom' })
    );
    expect(result.status).toBe('harness_error');
  });

  test('a stream with no result is harness_error', () => {
    const { result } = parseClaudeEventStream(
      JSON.stringify({ type: 'system', subtype: 'init' })
    );
    expect(result.status).toBe('harness_error');
    expect(result.summary).toMatch(/No final_result/);
  });

  test('malformed and blank lines are skipped', () => {
    const ndjson = [
      '',
      'not json {{{',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    ].join('\n');
    expect(parseClaudeEventStream(ndjson).result).toEqual({ status: 'passed', summary: 'ok' });
  });
});

// ── The adapter seam: both harnesses normalize to the *same* contract ─────────

describe('claude-adapter: identical contract across harnesses', () => {
  test('pi and Claude fixtures for the same run normalize identically', () => {
    const pi = parseEventStream(fixture('pi-passed.ndjson'));
    const claude = parseClaudeEventStream(fixture('claude-passed.ndjson'));

    // Byte-identical normalized event sequence and terminal result — this is the
    // core regression guard for the adapter seam.
    expect(claude.events).toEqual(pi.events);
    expect(claude.result).toEqual(pi.result);
  });
});

// ── Invocation: non-interactive, auto-approved, exec-time auth ────────────────

describe('claude-adapter: invocation', () => {
  test('runs claude -p stream-json, auto-approved, git boundary, key at exec time', async () => {
    let captured: { cmd: string[]; env: Record<string, string>; stdin: string } | undefined;
    await runClaudeHarness(
      'cid',
      'do the work',
      'sk-ant-secret',
      async (_cid, cmd, env, stdin): Promise<ExecResult> => {
        captured = { cmd, env, stdin };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
          stderr: '',
        };
      }
    );

    expect(captured).toBeDefined();
    expect(captured!.cmd.slice(0, 2)).toEqual(['claude', '-p']);
    // Non-interactive streaming JSON contract.
    expect(captured!.cmd).toContain('--output-format');
    expect(captured!.cmd).toContain('stream-json');
    expect(captured!.cmd).toContain('--verbose');
    // Full auto-approval — no per-tool permission prompts.
    expect(captured!.cmd).toContain('--dangerously-skip-permissions');
    // Same instruct-only git boundary as pi.
    expect(captured!.cmd).toContain('--append-system-prompt');
    expect(captured!.cmd).toContain(ENGINE_OWNS_GIT_INSTRUCTION);
    // Prompt over stdin; auth injected only at exec time (never PI_API_KEY).
    expect(captured!.stdin).toBe('do the work');
    expect(captured!.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret');
    expect(captured!.env.PI_API_KEY).toBeUndefined();
  });

  test('streams normalized events live as chunks arrive', async () => {
    const raw = fixture('claude-passed.ndjson');
    const seen: HarnessEvent[] = [];
    await runClaudeHarness(
      'cid',
      'p',
      'k',
      async (_cid, _cmd, _env, _stdin, _signal, onStdout): Promise<ExecResult> => {
        // Feed the stream in awkward chunks to exercise the line buffering.
        for (let i = 0; i < raw.length; i += 7) onStdout?.(raw.slice(i, i + 7));
        return { exitCode: 0, stdout: raw, stderr: '' };
      },
      undefined,
      ev => seen.push(ev)
    );

    expect(seen.map(e => e.type)).toEqual(['task_started', 'activity', 'tool_use', 'final_result']);
  });

  test('a nonzero exit with no output is a harness_error', async () => {
    const result = await runClaudeHarness(
      'cid',
      'p',
      'k',
      async (): Promise<ExecResult> => ({ exitCode: 137, stdout: '', stderr: 'OOM killed' })
    );
    expect(result.status).toBe('harness_error');
    expect(result.summary).toMatch(/claude exited 137/);
  });

  test('an exec throw is caught as harness_error', async () => {
    const result = await runClaudeHarness(
      'cid',
      'p',
      'k',
      async (): Promise<ExecResult> => {
        throw new Error('spawn failed');
      }
    );
    expect(result.status).toBe('harness_error');
    expect(result.summary).toMatch(/exec error/);
  });
});

// ── Harness selection: defaults to pi, swappable per task/run ──────────────────

describe('claude-adapter: harness selection', () => {
  test('defaults to pi when nothing is specified', () => {
    expect(DEFAULT_HARNESS).toBe('pi');
    expect(selectHarness()).toBe(runPiHarness);
    expect(selectHarness(undefined, undefined)).toBe(runPiHarness);
  });

  test('selects claude by name', () => {
    expect(selectHarness('claude')).toBe(registeredClaude);
  });

  test('the first recognized candidate wins (task field over run override)', () => {
    expect(selectHarness('claude', 'pi')).toBe(registeredClaude);
    expect(selectHarness(undefined, 'claude')).toBe(registeredClaude);
  });

  test('unknown names fall back to the default', () => {
    expect(selectHarness('gpt-9000')).toBe(runPiHarness);
    expect(isHarness('claude')).toBe(true);
    expect(isHarness('nope')).toBe(false);
  });
});

// ── End-to-end: a Claude-selected task runs the exact same path as pi ──────────

interface Rig {
  deps: EngineDeps;
  commits: string[];
  harnessCmds: string[][];
  harnessEnvs: Array<Record<string, string>>;
}

function makeClaudeRig(): Rig {
  const commits: string[] = [];
  const harnessCmds: string[][] = [];
  const harnessEnvs: Array<Record<string, string>> = [];

  const deps: EngineDeps = {
    createWorktree: async () => {},
    removeWorktree: async () => {},
    resolveImage: async () => 'img:latest',
    startContainer: async () => 'cid-1',
    stopContainer: async () => {},
    commitAll: async (_repo, message) => {
      commits.push(message);
    },
    diffChanges: async () => '',
    execInContainer: async (_cid, cmd, env, _stdin): Promise<ExecResult> => {
      if (cmd[0] === 'claude') {
        harnessCmds.push(cmd);
        harnessEnvs.push(env ?? {});
        return { exitCode: 0, stdout: fixture('claude-passed.ndjson'), stderr: '' };
      }
      if (cmd[0] === 'cat') return { exitCode: 1, stdout: '', stderr: 'no file' };
      if (cmd[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      // verify command → success
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  return { deps, commits, harnessCmds, harnessEnvs };
}

describe('claude-adapter: end-to-end via the engine', () => {
  let dir: string;
  let dbPath: string;
  let wtBase: string;

  beforeEach(() => {
    dir = tmp('pi-claude-e2e');
    mkdirSync(dir, { recursive: true });
    dbPath = `${tmp('pi-claude-e2e')}.db`;
    wtBase = tmp('pi-claude-wt');
    writeFileSync(join(dir, 'README.md'), `---\nslug: t\nbranch: feat/t\nharness: claude\n---\n`, 'utf-8');
    writeFileSync(join(dir, '01-a.md'), `---\nslug: a\nverify: 'true'\n---\nbody a\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  test('frontmatter harness: claude routes the run through the Claude adapter, same path to commit', async () => {
    const rig = makeClaudeRig();
    const db = openDb(dbPath);

    await runTask(loadTaskSpec(dir), {
      repoPath: dir, apiKey: 'sk-ant-secret', db, deps: rig.deps, worktreesDir: wtBase, attemptTimeoutMs: 2000,
    });

    // Harness ran as Claude (not pi), with exec-time Anthropic auth.
    expect(rig.harnessCmds.length).toBe(1);
    expect(rig.harnessCmds[0][0]).toBe('claude');
    expect(rig.harnessEnvs[0].ANTHROPIC_API_KEY).toBe('sk-ant-secret');

    // Same downstream path: verify passed → one commit per passing subtask.
    expect(rig.commits).toEqual(['t(a): passed']);

    const taskId = new TaskRepository(db).upsert('t', 'feat/t');
    const subs = new SubtaskRepository(db);
    expect(subs.getStatus(subs.findId(taskId, 'a'))).toBe('passed');
    db.close();
  });
});
