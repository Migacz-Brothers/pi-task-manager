import { Database } from 'bun:sqlite';
import type { SubtaskStatus } from './types.ts';

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      slug    TEXT    NOT NULL UNIQUE,
      branch  TEXT    NOT NULL,
      status  TEXT    NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      INTEGER NOT NULL REFERENCES tasks(id),
      slug         TEXT    NOT NULL,
      verify       TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      attempts     INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT    NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(task_id, slug)
    );

    CREATE TABLE IF NOT EXISTS commands (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_slug    TEXT    NOT NULL,
      subtask_slug TEXT,
      action       TEXT    NOT NULL,
      payload      TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      consumed     INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function upsertTask(db: Database, slug: string, branch: string): number {
  db.run(
    `INSERT INTO tasks (slug, branch) VALUES (?, ?)
     ON CONFLICT(slug) DO UPDATE SET branch = excluded.branch`,
    [slug, branch]
  );
  const row = db.query('SELECT id FROM tasks WHERE slug = ?').get(slug) as { id: number };
  return row.id;
}

export function upsertSubtask(
  db: Database,
  taskId: number,
  slug: string,
  verify: string,
  contentHash: string
): number {
  db.run(
    `INSERT INTO subtasks (task_id, slug, verify, content_hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, slug) DO UPDATE SET
       verify       = excluded.verify,
       content_hash = excluded.content_hash,
       updated_at   = unixepoch()`,
    [taskId, slug, verify, contentHash]
  );
  const row = db
    .query('SELECT id FROM subtasks WHERE task_id = ? AND slug = ?')
    .get(taskId, slug) as { id: number };
  return row.id;
}

export function setSubtaskStatus(db: Database, subtaskId: number, status: SubtaskStatus): void {
  db.run(
    `UPDATE subtasks SET status = ?, updated_at = unixepoch() WHERE id = ?`,
    [status, subtaskId]
  );
}

export function incrementAttempts(db: Database, subtaskId: number): void {
  db.run(
    `UPDATE subtasks SET attempts = attempts + 1, updated_at = unixepoch() WHERE id = ?`,
    [subtaskId]
  );
}

export function getSubtaskStatus(db: Database, subtaskId: number): SubtaskStatus {
  const row = db
    .query('SELECT status FROM subtasks WHERE id = ?')
    .get(subtaskId) as { status: SubtaskStatus } | null;
  if (!row) throw new Error(`Subtask ${subtaskId} not found`);
  return row.status;
}
