import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { loadTaskSpec, SpecLoadError } from '../src/spec-loader.ts';
import { openDb, TaskRepository, SubtaskRepository } from '../src/infra/db/index.ts';
import { parseEventStream } from '../src/harness-adapter.ts';

// ── Spec Loader ───────────────────────────────────────────────────────────────

describe('skeleton: spec-loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `pi-skeleton-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  test('parses a valid task with one subtask', () => {
    write('README.md', `---
slug: my-task
branch: feat/my-task
---
# My Task
`);
    write('01-first.md', `---
slug: first
verify: echo ok
hitl: false
blockedBy: []
---
Do the first thing.
`);

    const task = loadTaskSpec(dir);

    expect(task.slug).toBe('my-task');
    expect(task.branch).toBe('feat/my-task');
    expect(task.subtasks).toHaveLength(1);
    expect(task.subtasks[0].slug).toBe('first');
    expect(task.subtasks[0].verify).toBe('echo ok');
    expect(task.subtasks[0].hitl).toBe(false);
    expect(task.subtasks[0].blockedBy).toEqual([]);
    expect(task.subtasks[0].body).toBe('Do the first thing.');
  });

  test('subtasks sorted by NN- filename prefix', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('02-second.md', `---
slug: second
verify: echo 2
---
second
`);
    write('01-first.md', `---
slug: first
verify: echo 1
---
first
`);

    const task = loadTaskSpec(dir);

    expect(task.subtasks[0].slug).toBe('first');
    expect(task.subtasks[1].slug).toBe('second');
  });

  test('content hash is a 16-char hex string', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('01-sub.md', `---
slug: sub
verify: echo ok
---
body
`);

    const task = loadTaskSpec(dir);

    expect(task.subtasks[0].contentHash).toMatch(/^[a-f0-9]{16}$/);
  });

  test('two identical subtask files get same hash', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    const content = `---
slug: a
verify: echo ok
---
same body
`;
    write('01-a.md', content);
    write('02-b.md', content.replace('slug: a', 'slug: b'));

    const task = loadTaskSpec(dir);

    // Both files have same body/verify but different slugs so hashes differ
    expect(task.subtasks[0].contentHash).not.toBe('');
  });

  test('optional image field is parsed', () => {
    write('README.md', `---
slug: t
branch: b
image: custom:1.0
---
`);
    write('01-sub.md', `---
slug: sub
verify: echo ok
---
body
`);

    const task = loadTaskSpec(dir);

    expect(task.image).toBe('custom:1.0');
  });

  test('image is undefined when not specified', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('01-sub.md', `---
slug: sub
verify: echo ok
---
body
`);

    const task = loadTaskSpec(dir);

    expect(task.image).toBeUndefined();
  });

  test('throws SpecLoadError on missing slug in README', () => {
    write('README.md', `---
branch: feat/x
---
`);

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
  });

  test('throws SpecLoadError on missing branch in README', () => {
    write('README.md', `---
slug: my-task
---
`);

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
  });

  test('throws SpecLoadError on missing verify in subtask', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('01-sub.md', `---
slug: sub
---
body
`);

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
  });

  test('throws SpecLoadError on missing slug in subtask', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('01-sub.md', `---
verify: echo ok
---
body
`);

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
  });

  test('throws SpecLoadError on duplicate subtask slugs', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('01-a.md', `---
slug: dup
verify: echo ok
---
`);
    write('02-b.md', `---
slug: dup
verify: echo ok
---
`);

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
  });

  test('throws SpecLoadError when blockedBy references unknown slug', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('01-a.md', `---
slug: first
verify: echo ok
blockedBy:
  - nonexistent
---
`);

    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
  });

  test('valid blockedBy reference does not throw', () => {
    write('README.md', `---
slug: t
branch: b
---
`);
    write('01-a.md', `---
slug: first
verify: echo ok
---
`);
    write('02-b.md', `---
slug: second
verify: echo ok
blockedBy:
  - first
---
`);

    expect(() => loadTaskSpec(dir)).not.toThrow();
    const task = loadTaskSpec(dir);
    expect(task.subtasks[1].blockedBy).toEqual(['first']);
  });

  test('throws SpecLoadError when README.md is missing', () => {
    expect(() => loadTaskSpec(dir)).toThrow(SpecLoadError);
  });
});

// ── DB Repositories ───────────────────────────────────────────────────────────

describe('skeleton: db', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `pi-skeleton-${process.pid}-${Date.now()}.db`);
  });

  afterEach(() => {
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  test('opens and migrates creating all required tables', () => {
    const db = openDb(dbPath);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map(r => r.name);

    expect(names).toContain('tasks');
    expect(names).toContain('subtasks');
    expect(names).toContain('commands');
    db.close();
  });

  test('migrate is idempotent (safe to run twice)', () => {
    const db1 = openDb(dbPath);
    db1.close();
    expect(() => openDb(dbPath)).not.toThrow();
  });

  test('TaskRepository.upsert returns a positive integer id', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const id = tasks.upsert('task-a', 'feat/a');
    expect(id).toBeGreaterThan(0);
    db.close();
  });

  test('TaskRepository.upsert is idempotent', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const id1 = tasks.upsert('task-a', 'feat/a');
    const id2 = tasks.upsert('task-a', 'feat/a');
    expect(id1).toBe(id2);
    db.close();
  });

  test('TaskRepository.findById returns the inserted row', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const id = tasks.upsert('task-a', 'feat/a');
    const row = tasks.findById(id);
    expect(row?.slug).toBe('task-a');
    expect(row?.branch).toBe('feat/a');
    db.close();
  });

  test('SubtaskRepository.upsert returns a positive integer id', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('task-a', 'feat/a');
    const subtaskId = subtasks.upsert(taskId, 'first', 'echo ok', 'abc123');
    expect(subtaskId).toBeGreaterThan(0);
    db.close();
  });

  test('new subtask defaults to pending status', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('task-a', 'feat/a');
    const subtaskId = subtasks.upsert(taskId, 'first', 'echo ok', 'abc123');
    expect(subtasks.getStatus(subtaskId)).toBe('pending');
    db.close();
  });

  test('SubtaskRepository.setStatus persists status changes', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('task-a', 'feat/a');
    const subtaskId = subtasks.upsert(taskId, 'first', 'echo ok', 'abc123');

    subtasks.setStatus(subtaskId, 'running');
    expect(subtasks.getStatus(subtaskId)).toBe('running');

    subtasks.setStatus(subtaskId, 'passed');
    expect(subtasks.getStatus(subtaskId)).toBe('passed');

    subtasks.setStatus(subtaskId, 'verify_failed');
    expect(subtasks.getStatus(subtaskId)).toBe('verify_failed');
    db.close();
  });

  test('SubtaskRepository.getStatus throws for unknown id', () => {
    const db = openDb(dbPath);
    const subtasks = new SubtaskRepository(db);
    expect(() => subtasks.getStatus(99999)).toThrow();
    db.close();
  });

  test('SubtaskRepository.findId throws when subtask not found', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('task-a', 'feat/a');
    expect(() => subtasks.findId(taskId, 'nonexistent')).toThrow();
    db.close();
  });

  test('SubtaskRepository.findById returns row with correct fields', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('task-a', 'feat/a');
    const subtaskId = subtasks.upsert(taskId, 'first', 'echo ok', 'abc123');
    const row = subtasks.findById(subtaskId);
    expect(row?.slug).toBe('first');
    expect(row?.verify).toBe('echo ok');
    expect(row?.attempts).toBe(0);
    db.close();
  });

  test('SubtaskRepository.incrementAttempts increments the counter', () => {
    const db = openDb(dbPath);
    const tasks = new TaskRepository(db);
    const subtasks = new SubtaskRepository(db);
    const taskId = tasks.upsert('task-a', 'feat/a');
    const subtaskId = subtasks.upsert(taskId, 'first', 'echo ok', 'abc123');
    subtasks.incrementAttempts(subtaskId);
    subtasks.incrementAttempts(subtaskId);
    const row = subtasks.findById(subtaskId);
    expect(row?.attempts).toBe(2);
    db.close();
  });
});

// ── Harness Adapter ───────────────────────────────────────────────────────────

describe('skeleton: harness-adapter', () => {
  test('normalizes a complete passed stream', () => {
    const ndjson = [
      JSON.stringify({ type: 'task_started' }),
      JSON.stringify({ type: 'activity', text: 'Writing code...' }),
      JSON.stringify({ type: 'tool_use', tool: 'write_file', input: { path: 'foo.ts' } }),
      JSON.stringify({ type: 'final_result', status: 'passed', summary: 'Done.' }),
    ].join('\n');

    const { events, result } = parseEventStream(ndjson);

    expect(result).toEqual({ status: 'passed', summary: 'Done.' });
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('task_started');
    expect(events[1].type).toBe('activity');
    expect(events[2].type).toBe('tool_use');
    expect(events[3].type).toBe('final_result');
  });

  test('normalizes a verify_failed stream', () => {
    const ndjson = [
      JSON.stringify({ type: 'task_started' }),
      JSON.stringify({ type: 'final_result', status: 'verify_failed', summary: 'Tests failed.' }),
    ].join('\n');

    const { result } = parseEventStream(ndjson);

    expect(result.status).toBe('verify_failed');
    expect(result.summary).toBe('Tests failed.');
  });

  test('normalizes a harness_error stream', () => {
    const ndjson = JSON.stringify({
      type: 'final_result',
      status: 'harness_error',
      summary: 'Crashed.',
    });

    const { result } = parseEventStream(ndjson);

    expect(result.status).toBe('harness_error');
  });

  test('returns harness_error when no final_result event present', () => {
    const ndjson = [
      JSON.stringify({ type: 'task_started' }),
      JSON.stringify({ type: 'activity', text: 'Working...' }),
    ].join('\n');

    const { result } = parseEventStream(ndjson);

    expect(result.status).toBe('harness_error');
    expect(result.summary).toMatch(/No final_result/);
  });

  test('maps unknown status value to harness_error', () => {
    const ndjson = JSON.stringify({
      type: 'final_result',
      status: 'totally_unknown',
      summary: 'x',
    });

    const { result } = parseEventStream(ndjson);

    expect(result.status).toBe('harness_error');
  });

  test('ignores malformed JSON lines without throwing', () => {
    const ndjson = [
      'not valid json {{{{',
      JSON.stringify({ type: 'final_result', status: 'passed', summary: 'ok' }),
    ].join('\n');

    const { result } = parseEventStream(ndjson);

    expect(result.status).toBe('passed');
  });

  test('ignores blank lines', () => {
    const ndjson = [
      '',
      JSON.stringify({ type: 'final_result', status: 'passed', summary: 'ok' }),
      '',
    ].join('\n');

    const { result } = parseEventStream(ndjson);

    expect(result.status).toBe('passed');
  });

  test('extracts activity text correctly', () => {
    const ndjson = [
      JSON.stringify({ type: 'activity', text: 'Editing index.ts...' }),
      JSON.stringify({ type: 'final_result', status: 'passed', summary: 'ok' }),
    ].join('\n');

    const { events } = parseEventStream(ndjson);
    const activity = events.find(e => e.type === 'activity');

    expect(activity).toBeDefined();
    if (activity?.type === 'activity') {
      expect(activity.text).toBe('Editing index.ts...');
    }
  });

  test('extracts tool_use with tool name and input', () => {
    const ndjson = [
      JSON.stringify({ type: 'tool_use', tool: 'read_file', input: { path: 'src/foo.ts' } }),
      JSON.stringify({ type: 'final_result', status: 'passed', summary: 'ok' }),
    ].join('\n');

    const { events } = parseEventStream(ndjson);
    const toolUse = events.find(e => e.type === 'tool_use');

    expect(toolUse?.type).toBe('tool_use');
    if (toolUse?.type === 'tool_use') {
      expect(toolUse.tool).toBe('read_file');
      expect(toolUse.input).toEqual({ path: 'src/foo.ts' });
    }
  });

  test('ignores unknown event types', () => {
    const ndjson = [
      JSON.stringify({ type: 'some_future_event', data: 'x' }),
      JSON.stringify({ type: 'final_result', status: 'passed', summary: 'ok' }),
    ].join('\n');

    const { events, result } = parseEventStream(ndjson);

    // only the final_result survives (unknown type is filtered out)
    expect(events).toHaveLength(1);
    expect(result.status).toBe('passed');
  });

  test('uses last final_result when multiple are present', () => {
    const ndjson = [
      JSON.stringify({ type: 'final_result', status: 'verify_failed', summary: 'first' }),
      JSON.stringify({ type: 'final_result', status: 'passed', summary: 'second' }),
    ].join('\n');

    const { result } = parseEventStream(ndjson);

    expect(result.status).toBe('passed');
    expect(result.summary).toBe('second');
  });
});
