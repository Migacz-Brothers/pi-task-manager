import { Database } from 'bun:sqlite';
import type { SubtaskStatus } from '../../types.ts';

export interface SubtaskRow {
  id: number;
  task_id: number;
  slug: string;
  verify: string;
  status: SubtaskStatus;
  attempts: number;
  content_hash: string;
  current_activity: string | null;
  current_phase: string | null;
}

const ROW_COLUMNS =
  'id, task_id, slug, verify, status, attempts, content_hash, current_activity, current_phase';

export class SubtaskRepository {
  constructor(private readonly db: Database) {}

  /**
   * Upsert a subtask definition keyed by (task_id, slug).
   *
   * Frontmatter is read-only to the engine, so the source of truth for a
   * subtask's definition is its file. When the file's content hash drifts from
   * what we stored, the definition changed underneath us: we re-seed by resetting
   * status to 'pending' and attempts to 0 so the subtask runs again. An unchanged
   * hash preserves prior run state (e.g. a 'passed' subtask stays passed).
   */
  upsert(taskId: number, slug: string, verify: string, contentHash: string): number {
    this.db.run(
      `INSERT INTO subtasks (task_id, slug, verify, content_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, slug) DO UPDATE SET
         verify       = excluded.verify,
         status       = CASE WHEN subtasks.content_hash <> excluded.content_hash
                             THEN 'pending' ELSE subtasks.status END,
         attempts     = CASE WHEN subtasks.content_hash <> excluded.content_hash
                             THEN 0 ELSE subtasks.attempts END,
         content_hash = excluded.content_hash,
         updated_at   = unixepoch()`,
      [taskId, slug, verify, contentHash]
    );
    const row = this.db
      .query('SELECT id FROM subtasks WHERE task_id = ? AND slug = ?')
      .get(taskId, slug) as { id: number };
    return row.id;
  }

  /**
   * Drop subtask rows for this task whose slug is not in `keepSlugs`, reconciling
   * the store with subtask files that were removed between runs. Returns the
   * number of rows pruned.
   */
  deleteOrphans(taskId: number, keepSlugs: string[]): number {
    if (keepSlugs.length === 0) {
      return this.db.run('DELETE FROM subtasks WHERE task_id = ?', [taskId]).changes;
    }
    const placeholders = keepSlugs.map(() => '?').join(', ');
    return this.db.run(
      `DELETE FROM subtasks WHERE task_id = ? AND slug NOT IN (${placeholders})`,
      [taskId, ...keepSlugs]
    ).changes;
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
      .query(`SELECT ${ROW_COLUMNS} FROM subtasks WHERE id = ?`)
      .get(id) as SubtaskRow | null;
  }

  /**
   * Every subtask of a task, ordered by id (creation order, which mirrors the
   * `NN-` file order the engine seeds them in). The TUI's read model for the tree.
   */
  listByTask(taskId: number): SubtaskRow[] {
    return this.db
      .query(`SELECT ${ROW_COLUMNS} FROM subtasks WHERE task_id = ? ORDER BY id ASC`)
      .all(taskId) as SubtaskRow[];
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

  /**
   * Stamp the running subtask's throttled one-line activity (+ phase). Engine-only
   * write; the TUI reads it for the live activity line. Throttling is the caller's
   * responsibility — this is the raw setter.
   */
  setActivity(id: number, activity: string, phase: string): void {
    this.db.run(
      `UPDATE subtasks SET current_activity = ?, current_phase = ?, updated_at = unixepoch() WHERE id = ?`,
      [activity, phase, id]
    );
  }

  /** Clear the live activity once a subtask stops running (passed/failed/paused). */
  clearActivity(id: number): void {
    this.db.run(
      `UPDATE subtasks SET current_activity = NULL, current_phase = NULL, updated_at = unixepoch() WHERE id = ?`,
      [id]
    );
  }
}
