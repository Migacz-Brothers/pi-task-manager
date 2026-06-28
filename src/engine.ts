import type { Database } from 'bun:sqlite';
import type { TaskSpec, SubtaskStatus } from './types.ts';
import { schedule } from './scheduler.ts';
import { TaskRepository, SubtaskRepository } from './infra/db/index.ts';
import { runPiHarness } from './harness-adapter.ts';
import type { ExecResult } from './harness-adapter.ts';
import {
  startContainer,
  execInContainer,
  stopContainer,
} from './infra/container-manager.ts';
import { ensureBranch, commitAll } from './infra/git-manager.ts';

const DEFAULT_IMAGE = 'ubuntu:22.04';

/**
 * The side-effecting seams the engine drives (container, exec, git). Injectable
 * so the sequential-execution behavior can be tested without Docker or a real
 * repo; defaults to the real implementations.
 */
export interface EngineDeps {
  ensureBranch(repoPath: string, branch: string): Promise<void>;
  startContainer(
    image: string,
    repoPath: string,
    label: string,
    env: Record<string, string>
  ): Promise<string>;
  execInContainer(
    containerId: string,
    cmd: string[],
    env?: Record<string, string>,
    stdin?: string
  ): Promise<ExecResult>;
  stopContainer(containerId: string): Promise<void>;
  commitAll(repoPath: string, message: string): Promise<void>;
}

const defaultDeps: EngineDeps = {
  ensureBranch,
  startContainer,
  execInContainer,
  stopContainer,
  commitAll,
};

export interface EngineOptions {
  repoPath: string;
  apiKey: string;
  db: Database;
  deps?: EngineDeps;
}

export async function runTask(task: TaskSpec, opts: EngineOptions): Promise<void> {
  const { repoPath, apiKey, db } = opts;
  const deps = opts.deps ?? defaultDeps;
  const taskRepo = new TaskRepository(db);
  const subtaskRepo = new SubtaskRepository(db);

  const taskId = taskRepo.upsert(task.slug, task.branch);

  // Seed/reconcile definitions from the files: upsert re-seeds on content drift,
  // and pruning drops rows for subtask files removed since the last run.
  for (const subtask of task.subtasks) {
    subtaskRepo.upsert(taskId, subtask.slug, subtask.verify, subtask.contentHash);
  }
  subtaskRepo.deleteOrphans(taskId, task.subtasks.map(s => s.slug));

  await deps.ensureBranch(repoPath, task.branch);

  const image = task.image ?? DEFAULT_IMAGE;
  const containerLabel = `pi-task-manager.task=${task.slug}`;

  let containerId: string;
  try {
    containerId = await deps.startContainer(image, repoPath, containerLabel, {
      PI_API_KEY: apiKey,
    });
  } catch (err) {
    throw new Error(`Container failed to start for task '${task.slug}': ${err}`);
  }

  // Graph nodes for the scheduler: stable slug + declared dependencies. The
  // scheduler is a pure function of (this graph, runtime state); the engine owns
  // all the I/O and the "halt on failure" policy around it.
  const nodes = task.subtasks.map(s => ({ slug: s.slug, blockedBy: s.blockedBy }));
  const bodyBySlug = new Map(task.subtasks.map(s => [s.slug, s]));

  const snapshot = (): Map<string, SubtaskStatus> => {
    const m = new Map<string, SubtaskStatus>();
    for (const s of task.subtasks) {
      m.set(s.slug, subtaskRepo.getStatus(subtaskRepo.findId(taskId, s.slug)));
    }
    return m;
  };

  try {
    // A failure (with no retry yet — that is 04) halts the task: we stop pulling
    // new runnable work but still apply the cascade so dependents end `blocked`
    // rather than silently `pending`.
    let halted = false;

    while (true) {
      const state = snapshot();
      const { runnable, blocked } = schedule(nodes, state);

      // Cascade: mark every transitive dependent of a non-passed subtask blocked.
      for (const slug of blocked) {
        if (state.get(slug) === 'blocked') continue;
        subtaskRepo.setStatus(subtaskRepo.findId(taskId, slug), 'blocked');
        console.log(`  [${slug}] blocked (a dependency did not pass)`);
      }

      // `runnable` excludes already-`passed` subtasks, so resumed runs skip them
      // and produce no duplicate commits.
      if (halted || runnable.length === 0) break;

      const subtask = bodyBySlug.get(runnable[0])!;
      const subtaskId = subtaskRepo.findId(taskId, subtask.slug);

      subtaskRepo.setStatus(subtaskId, 'running');
      subtaskRepo.incrementAttempts(subtaskId);

      const finalResult = await runPiHarness(
        containerId,
        subtask.body,
        apiKey,
        (cid, cmd, env, stdin) => deps.execInContainer(cid, cmd, env, stdin)
      );

      if (finalResult.status !== 'passed') {
        subtaskRepo.setStatus(subtaskId, finalResult.status);
        console.log(`  [${subtask.slug}] ${finalResult.status}: ${finalResult.summary}`);
        halted = true;
        continue; // re-loop once to cascade `blocked` onto this subtask's dependents
      }

      const verifyResult = await deps.execInContainer(containerId, ['sh', '-c', subtask.verify]);

      if (verifyResult.exitCode !== 0) {
        subtaskRepo.setStatus(subtaskId, 'verify_failed');
        console.log(`  [${subtask.slug}] verify_failed`);
        if (verifyResult.stdout) console.log(verifyResult.stdout);
        if (verifyResult.stderr) console.log(verifyResult.stderr);
        halted = true;
        continue; // re-loop once to cascade `blocked` onto this subtask's dependents
      }

      // One commit per passing subtask. The message encodes task + subtask slug
      // so the branch history is self-describing and the engine can later
      // recognize its own checkpoints.
      await deps.commitAll(repoPath, `${task.slug}(${subtask.slug}): passed`);
      subtaskRepo.setStatus(subtaskId, 'passed');
      console.log(`  [${subtask.slug}] passed`);
    }
  } finally {
    await deps.stopContainer(containerId);
  }
}
