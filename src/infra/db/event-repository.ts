import { Database } from 'bun:sqlite';

export interface EventRow {
  id: number;
  task_slug: string;
  subtask_slug: string | null;
  type: string;
  detail: string | null;
  created_at: number;
}

/**
 * Append-only history of orchestrator-boundary events: pauses (`needs_human`) and
 * the human commands applied to resolve them. The TUI reads this to render a
 * timeline; tests read it to assert a command was applied exactly once.
 */
export class EventRepository {
  constructor(private readonly db: Database) {}

  record(taskSlug: string, subtaskSlug: string | null, type: string, detail?: string): number {
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO events (task_slug, subtask_slug, type, detail) VALUES (?, ?, ?, ?)`,
      [taskSlug, subtaskSlug, type, detail ?? null]
    );
    return Number(lastInsertRowid);
  }

  /** Every event for a task, oldest first. */
  list(taskSlug: string): EventRow[] {
    return this.db
      .query(
        `SELECT id, task_slug, subtask_slug, type, detail, created_at
           FROM events WHERE task_slug = ? ORDER BY id ASC`
      )
      .all(taskSlug) as EventRow[];
  }
}
