import type { TaskSpec } from './types.ts';

/**
 * Task-level concurrency cap. A script-level constant (not frontmatter / config
 * surface) for v1, per the slice spec: independent tasks run in parallel but the
 * machine and token budget stay bounded by running at most this many at once.
 */
export const MAX_CONCURRENT_TASKS = 2;

export interface RunQueueOptions {
  /** How many tasks may run at once. Defaults to {@link MAX_CONCURRENT_TASKS}. */
  concurrency?: number;
  /**
   * Run a single task to completion (container + worktree + sequential subtasks).
   * Injectable so the pool's concurrency/ordering behavior is testable without
   * Docker; production wires {@link runTask} from the engine.
   */
  runTask(task: TaskSpec): Promise<void>;
}

/**
 * Drain a queue of independent tasks through a fixed-size worker pool.
 *
 * Ordering is deterministic: workers pull from a single shared cursor, so the
 * lowest-index `pending` task is always claimed next. With `concurrency` workers
 * at most that many tasks are in flight; the next task starts the instant a slot
 * frees. A task that throws (e.g. its container fails to start) is logged and
 * swallowed so its worker immediately picks up the next task — one bad task never
 * stalls the queue. Resolves once every task has been claimed and settled, which
 * is the engine's one-shot "run until the queue drains, then exit" guarantee.
 */
export async function runQueue(tasks: TaskSpec[], opts: RunQueueOptions): Promise<void> {
  const limit = Math.max(1, opts.concurrency ?? MAX_CONCURRENT_TASKS);

  // Shared cursor: incremented synchronously on claim, so no two workers ever
  // take the same task and the claim order is exactly the input order.
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const task = tasks[next++];
      console.log(`Task: ${task.slug}  branch: ${task.branch}`);
      try {
        await opts.runTask(task);
      } catch (err) {
        // A failed task frees its slot for the next one rather than aborting the
        // whole run; crash recovery / reconciliation is slice 08's job.
        console.error(`Task '${task.slug}' failed: ${err}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
}
