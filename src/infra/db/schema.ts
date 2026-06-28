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
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id          INTEGER NOT NULL REFERENCES tasks(id),
      slug             TEXT    NOT NULL,
      verify           TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'pending',
      attempts         INTEGER NOT NULL DEFAULT 0,
      content_hash     TEXT    NOT NULL,
      -- Throttled one-line activity (+ phase) the engine stamps on the running
      -- subtask as it consumes the harness stream; the TUI reads these for the
      -- live activity line. Null when the subtask is not actively running.
      current_activity TEXT,
      current_phase    TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
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

    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_slug    TEXT    NOT NULL,
      subtask_slug TEXT,
      type         TEXT    NOT NULL,
      detail       TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Additive migration for databases created before the activity columns existed
  // (the CREATE above is a no-op once the table is present). SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, so probe the column set and add what's missing.
  addColumnIfMissing(db, 'subtasks', 'current_activity', 'TEXT');
  addColumnIfMissing(db, 'subtasks', 'current_phase', 'TEXT');
}

function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
