import { Database } from 'bun:sqlite';

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT    NOT NULL UNIQUE,
      branch     TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'pending',
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
