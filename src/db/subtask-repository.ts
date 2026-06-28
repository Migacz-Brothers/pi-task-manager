import { Database } from 'bun:sqlite';
import type { SubtaskStatus } from '../types.ts';

export interface SubtaskRow {
  id: number;
  task_id: number;
  slug: string;
  verify: string;
  status: SubtaskStatus;
  attempts: number;
  content_hash: string;
}

export class SubtaskRepository {
  constructor(private readonly db: Database) {}

  upsert(taskId: number, slug: string, verify: string, contentHash: string): number {
    this.db.run(
      `INSERT INTO subtasks (task_id, slug, verify, content_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, slug) DO UPDATE SET
         verify       = excluded.verify,
         content_hash = excluded.content_hash,
         updated_at   = unixepoch()`,
      [taskId, slug, verify, contentHash]
    );
    const row = this.db
      .query('SELECT id FROM subtasks WHERE task_id = ? AND slug = ?')
      .get(taskId, slug) as { id: number };
    return row.id;
  }

  findId(taskId: number, slug: string): number {
    const row = this.db
      .query('SELECT id FROM subtasks WHERE task_id = ? AND slug = ?')
      .get(taskId, slug) as { id: number } | null;
    if (!row) throw new Error(`Subtask '${slug}' not found for task ${taskId}`);
    return row.id;
  }

  findById(id: number): SubtaskRow | null {
    return this.db
      .query('SELECT id, task_id, slug, verify, status, attempts, content_hash FROM subtasks WHERE id = ?')
      .get(id) as SubtaskRow | null;
  }

  getStatus(id: number): SubtaskStatus {
    const row = this.db
      .query('SELECT status FROM subtasks WHERE id = ?')
      .get(id) as { status: SubtaskStatus } | null;
    if (!row) throw new Error(`Subtask ${id} not found`);
    return row.status;
  }

  setStatus(id: number, status: SubtaskStatus): void {
    this.db.run(
      `UPDATE subtasks SET status = ?, updated_at = unixepoch() WHERE id = ?`,
      [status, id]
    );
  }

  incrementAttempts(id: number): void {
    this.db.run(
      `UPDATE subtasks SET attempts = attempts + 1, updated_at = unixepoch() WHERE id = ?`,
      [id]
    );
  }
}
