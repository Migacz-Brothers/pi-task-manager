import type { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { TaskSpec, SubtaskStatus, FinalResult, FinalStatus } from './types.ts';
import { schedule } from './scheduler.ts';
import { TaskRepository, SubtaskRepository } from './infra/db/index.ts';
import { runPiHarness } from './harness-adapter.ts';
import type { ExecResult } from './harness-adapter.ts';
import { assembleRetryPrompt } from './context-assembler.ts';
import {
  startContainer,
  execInContainer,
  stopContainer,
} from './infra/container-manager.ts';
import { createWorktree, removeWorktree, commitAll, diffChanges } from './infra/git-manager.ts';

const DEFAULT_IMAGE = 'ubuntu:22.04';

/**
 * Retry policy constants — script-level, deliberately not frontmatter fields so
 * a subtask spec can't weaken the failure bound. `MAX_ATTEMPTS` (K) caps how many
 * times a subtask is attempted before it escalates to `needs_human`;
 * `ATTEMPT_TIMEOUT_MS` is the per-attempt wall-clock budget after which a hung
 * harness run is killed and classified as a `harness_error`.
 */
const MAX_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 20 * 60 * 1000;

/** Where the harness is expected to leave handoff notes between attempts. */
const FRAGMENT_PATH = '.orchestrator/handoff.md';

/**
 * The side-effecting seams the engine drives (container, exec, git). Injectable
 * so the sequential-execution behavior can be tested without Docker or a real
 * repo; defaults to the real implementations.
 */
export interface EngineDeps {
  createWorktree(repoPath: string, branch: string, worktreePath: string): Promise<void>;
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
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
    stdin?: string,
    signal?: AbortSignal
  ): Promise<ExecResult>;
  stopContainer(containerId: string): Promise<void>;
  commitAll(repoPath: string, message: string): Promise<void>;
  diffChanges(repoPath: string): Promise<string>;
}

const defaultDeps: EngineDeps = {
  createWorktree,
  removeWorktree,
  startContainer,
  execInContainer,
  stopContainer,
  commitAll,
  diffChanges,
};

export interface EngineOptions {
  repoPath: string;
  apiKey: string;
  db: Database;
  deps?: EngineDeps;
  /** Per-attempt wall-clock timeout; defaults to {@link ATTEMPT_TIMEOUT_MS} (overridable for tests). */
  attemptTimeoutMs?: number;
  /**
   * Base directory under which each task gets its own `<slug>` worktree. Defaults
   * to the gitignored state dir so worktrees never dirty the tracked tree.
   */
  worktreesDir?: string;
}

/**
 * Run one harness attempt under a wall-clock timeout. If the harness hasn't
 * settled by `timeoutMs`, the exec is aborted (killed) and the attempt is
 * classified as a `harness_error` rather than hanging the task forever.
 */
async function runAttempt(
  containerId: string,
  prompt: string,
  apiKey: string,
  timeoutMs: number,
  deps: EngineDeps
): Promise<FinalResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<FinalResult>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'harness_error', summary: `attempt timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });

  try {
    const run = runPiHarness(
      containerId,
      prompt,
      apiKey,
      (cid, cmd, env, stdin, signal) => deps.execInContainer(cid, cmd, env, stdin, signal),
      controller.signal
    );
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read the agent's handoff fragment if present, otherwise `undefined`. */
async function readFragment(containerId: string, deps: EngineDeps): Promise<string | undefined> {
  const res = await deps.execInContainer(containerId, ['cat', FRAGMENT_PATH]);
  if (res.exitCode !== 0) return undefined;
  return res.stdout.trim() ? res.stdout : undefined;
}

/** Clear the handoff fragment so a stale one can't leak into a later attempt. */
async function clearFragment(containerId: string, deps: EngineDeps): Promise<void> {
  await deps.execInContainer(containerId, ['rm', '-f', FRAGMENT_PATH]);
}

export async function runTask(task: TaskSpec, opts: EngineOptions): Promise<void> {
  const { repoPath, apiKey, db } = opts;
  const deps = opts.deps ?? defaultDeps;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const worktreesDir = opts.worktreesDir ?? join(repoPath, '.specs', '.state', 'worktrees');
  const taskRepo = new TaskRepository(db);
  const subtaskRepo = new SubtaskRepository(db);

  const taskId = taskRepo.upsert(task.slug, task.branch);

  // Seed/reconcile definitions from the files: upsert re-seeds on content drift,
  // and pruning drops rows for subtask files removed since the last run.
  for (const subtask of task.subtasks) {
    subtaskRepo.upsert(taskId, subtask.slug, subtask.verify, subtask.contentHash);
  }
  subtaskRepo.deleteOrphans(taskId, task.subtasks.map(s => s.slug));

  // Each task runs on its own worktree + branch (named from frontmatter). All git
  // operations — commit-per-subtask, diffs for retry context — target the
  // worktree, never the main checkout, so parallel tasks never clobber each other.
  const worktreePath = join(worktreesDir, task.slug);
  mkdirSync(worktreesDir, { recursive: true });
  await deps.createWorktree(repoPath, task.branch, worktreePath);

  const image = task.image ?? DEFAULT_IMAGE;
  const containerLabel = `pi-task-manager.task=${task.slug}`;

  let containerId: string;
  try {
    // Bind the container to the worktree (not the repo root): the agent edits
    // files in the isolated checkout, and its commits land on the task branch.
    containerId = await deps.startContainer(image, worktreePath, containerLabel, {
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

  // Cleanup disposition: only a clean, fully-completed run removes the worktree
  // (keeping the branch). A halt → needs_human, an abort, or a thrown error all
  // leave the worktree in place for inspection.
  let succeeded = false;
  try {
    // A failure halts the task: we stop pulling new runnable work but still apply
    // the cascade so dependents end `blocked` rather than silently `pending`.
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

      // Attempt loop: the first attempt runs the subtask body; each retry runs a
      // fresh harness over the partial changes still on disk (fix-forward), fed a
      // prompt assembled from the failure. After K attempts the subtask escalates.
      let prompt = subtask.body;
      let passed = false;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        subtaskRepo.setStatus(subtaskId, 'running');
        subtaskRepo.incrementAttempts(subtaskId);

        const harnessResult = await runAttempt(containerId, prompt, apiKey, attemptTimeoutMs, deps);

        // Classify the attempt. A harness crash/timeout short-circuits; otherwise
        // the verify is authoritative — a self-reported success never overrides a
        // red verify.
        let outcome: FinalStatus;
        let verifyOutput = '';
        if (harnessResult.status === 'harness_error') {
          outcome = 'harness_error';
          verifyOutput = harnessResult.summary;
        } else {
          const verifyResult = await deps.execInContainer(containerId, ['sh', '-c', subtask.verify]);
          if (verifyResult.exitCode === 0) {
            outcome = 'passed';
          } else {
            outcome = 'verify_failed';
            verifyOutput = [verifyResult.stdout, verifyResult.stderr].filter(Boolean).join('\n');
          }
        }

        if (outcome === 'passed') {
          // One commit per passing subtask. The message encodes task + subtask
          // slug so the branch history is self-describing and the engine can
          // later recognize its own checkpoints.
          await deps.commitAll(worktreePath, `${task.slug}(${subtask.slug}): passed`);
          subtaskRepo.setStatus(subtaskId, 'passed');
          console.log(`  [${subtask.slug}] passed (attempt ${attempt}/${MAX_ATTEMPTS})`);
          passed = true;
          break;
        }

        subtaskRepo.setStatus(subtaskId, outcome);
        console.log(`  [${subtask.slug}] ${outcome} (attempt ${attempt}/${MAX_ATTEMPTS})`);
        if (verifyOutput) console.log(verifyOutput);

        // Fold any handoff fragment into the next attempt, then clear it so it
        // can't leak forward stale.
        const fragment = await readFragment(containerId, deps);
        await clearFragment(containerId, deps);

        if (attempt < MAX_ATTEMPTS) {
          const diff = await deps.diffChanges(worktreePath);
          prompt = assembleRetryPrompt({
            body: subtask.body,
            attempt: attempt + 1,
            maxAttempts: MAX_ATTEMPTS,
            verifyOutput,
            diff,
            fragment,
          });
        }
      }

      if (!passed) {
        // K attempts exhausted: escalate and halt the task. Re-loop once so the
        // cascade marks this subtask's dependents `blocked`.
        subtaskRepo.setStatus(subtaskId, 'needs_human');
        console.log(`  [${subtask.slug}] needs_human after ${MAX_ATTEMPTS} attempts`);
        halted = true;
        continue;
      }
    }

    // Reached only when the loop drains all runnable work without halting: every
    // subtask passed. This is the sole path that earns worktree teardown.
    succeeded = !halted;
  } finally {
    await deps.stopContainer(containerId);

    // Success → remove the worktree, keep the branch (commits survive in the
    // shared object store). Any non-success exit keeps both for inspection.
    if (succeeded) {
      await deps.removeWorktree(repoPath, worktreePath);
    }
  }
}
