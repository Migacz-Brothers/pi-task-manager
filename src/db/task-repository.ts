import { Database } from 'bun:sqlite';

export interface TaskRow {
  id: number;
  slug: string;
  branch: string;
  status: string;
}

export class TaskRepository {
  constructor(private readonly db: Database) {}

  upsert(slug: string, branch: string): number {
    this.db.run(
      `INSERT INTO tasks (slug, branch) VALUES (?, ?)
       ON CONFLICT(slug) DO UPDATE SET branch = excluded.branch`,
      [slug, branch]
    );
    const row = this.db
      .query('SELECT id FROM tasks WHERE slug = ?')
      .get(slug) as { id: number };
    return row.id;
  }

  findById(id: number): TaskRow | null {
    return this.db
      .query('SELECT id, slug, branch, status FROM tasks WHERE id = ?')
      .get(id) as TaskRow | null;
  }
}
