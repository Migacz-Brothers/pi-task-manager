import { Database } from 'bun:sqlite';
import type { CommandAction } from '../../types.ts';

export interface CommandRow {
  id: number;
  task_slug: string;
  subtask_slug: string | null;
  action: CommandAction;
  payload: string | null;
  consumed: number;
}

/**
 * The `commands` bus is the one place a human (via the TUI/CLI) writes into the
 * engine's world. The engine is the sole reader: it polls for the next unconsumed
 * command targeting a paused subtask, applies it, and marks it consumed. Rows are
 * never deleted — the consumed flag plus the `events` table give a durable,
 * append-only history of every intervention.
 */
export class CommandRepository {
  constructor(private readonly db: Database) {}

  /** Enqueue a human intent for a (task, subtask). Returns the new command id. */
  enqueue(
    taskSlug: string,
    subtaskSlug: string | null,
    action: CommandAction,
    payload?: string
  ): number {
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO commands (task_slug, subtask_slug, action, payload) VALUES (?, ?, ?, ?)`,
      [taskSlug, subtaskSlug, action, payload ?? null]
    );
    return Number(lastInsertRowid);
  }

  /**
   * The oldest unconsumed command for a (task, subtask), or `null`. Ordering by
   * `id` is what makes two commands queued for one subtask apply deterministically
   * in the order they were issued.
   */
  nextPending(taskSlug: string, subtaskSlug: string): CommandRow | null {
    return this.db
      .query(
        `SELECT id, task_slug, subtask_slug, action, payload, consumed
           FROM commands
          WHERE task_slug = ? AND subtask_slug = ? AND consumed = 0
          ORDER BY id ASC
          LIMIT 1`
      )
      .get(taskSlug, subtaskSlug) as CommandRow | null;
  }

  /**
   * Mark a command consumed, guarded so it can only ever flip 0 → 1. Returns true
   * if this call is the one that consumed it — the basis for exactly-once
   * application even if the same row is seen twice.
   */
  consume(id: number): boolean {
    return this.db.run('UPDATE commands SET consumed = 1 WHERE id = ? AND consumed = 0', [id])
      .changes === 1;
  }
}
