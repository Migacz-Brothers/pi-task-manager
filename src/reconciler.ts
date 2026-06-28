import type { Database } from 'bun:sqlite';
import { killContainersByLabel, TASK_LABEL_KEY } from './infra/container-manager.ts';

/**
 * The side effect the reconciler drives — killing orphaned task containers.
 * Injectable so the reconciliation logic is testable without Docker; defaults to
 * the real label-filtered `docker kill`.
 */
export interface ReconcileDeps {
  /** Kill every container the engine could own (filtered by the task label key). */
  killOrphanContainers(): Promise<void>;
}

const defaultDeps: ReconcileDeps = {
  killOrphanContainers: () => killContainersByLabel(TASK_LABEL_KEY),
};

export interface ReconcileReport {
  /** Number of `running` subtasks reset to `pending` so the queue re-runs them. */
  resetSubtasks: number;
}

/**
 * Reconcile durable state against reality on startup, before the queue resumes.
 *
 * All durable state lives outside the process (SQLite, the worktree, git), so
 * recovery is reconciliation rather than checkpoint replay. This runs as a
 * one-shot at the start of a manual invocation — there is no supervisor or
 * daemon (out of scope for v1), so by construction **no engine owns anything
 * yet**. That single fact drives both steps:
 *
 *  1. Any subtask still marked `running` is a crash artifact from a prior run
 *     (a clean exit always leaves a terminal status). Reset it to `pending` —
 *     not `harness_error` — so the scheduler treats it as runnable again and
 *     re-runs *exactly* that subtask. Re-running is idempotent: every attempt is
 *     a fresh harness over the on-disk worktree (fix-forward), already-`passed`
 *     subtasks are skipped (no duplicate commits), and the per-subtask commit is
 *     a no-op when the change was already committed (see {@link commitAll}). The
 *     worst case after any crash is one interrupted subtask re-running.
 *
 *  2. Every container carrying the task label is likewise an orphan with no live
 *     owner, so kill them all to reclaim resources before new ones start. A
 *     stale worktree needs no action here — `createWorktree` prunes and reuses
 *     it under the isolation rules when the task next runs.
 *
 * Returns a small report for the caller to log; the heavy lifting is the two
 * idempotent side effects.
 */
export async function reconcile(
  db: Database,
  deps: ReconcileDeps = defaultDeps
): Promise<ReconcileReport> {
  const { changes } = db.run(
    `UPDATE subtasks
        SET status = 'pending', current_activity = NULL, current_phase = NULL,
            updated_at = unixepoch()
      WHERE status = 'running'`
  );

  await deps.killOrphanContainers();

  return { resetSubtasks: changes };
}
