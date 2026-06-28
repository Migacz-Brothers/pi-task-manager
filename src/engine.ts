import type { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { TaskSpec, SubtaskSpec, SubtaskStatus, FinalResult, FinalStatus, HarnessEvent } from './types.ts';
import { schedule } from './scheduler.ts';
import { TaskRepository, SubtaskRepository, CommandRepository, EventRepository } from './infra/db/index.ts';
import { runPiHarness } from './harness-adapter.ts';
import type { ExecResult } from './harness-adapter.ts';
import { assembleRetryPrompt } from './context-assembler.ts';
import {
  startContainer,
  execInContainer,
  stopContainer,
  taskLabel,
} from './infra/container-manager.ts';
import { createWorktree, removeWorktree, commitAll, diffChanges } from './infra/git-manager.ts';
import { execHost } from './infra/host-exec.ts';
import { buildTaskImage } from './infra/image-resolver.ts';

/**
 * Retry policy constants — script-level, deliberately not frontmatter fields so
 * a subtask spec can't weaken the failure bound. `MAX_ATTEMPTS` (K) caps how many
 * times a subtask is attempted before it escalates to `needs_human`;
 * `ATTEMPT_TIMEOUT_MS` is the per-attempt wall-clock budget after which a hung
 * harness run is killed and classified as a `harness_error`.
 */
const MAX_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Minimum spacing between `current_activity` writes while consuming the harness
 * stream. The stream can emit far faster than a human (or the ~250ms TUI poll)
 * can read, so activity is throttled to one write per this interval — the live
 * line stays current without hammering SQLite on every token.
 */
const ACTIVITY_THROTTLE_MS = 250;

/** Collapse a harness event into a single, length-capped activity line. */
function activityLine(ev: HarnessEvent): string | null {
  switch (ev.type) {
    case 'task_started':
      return 'agent started';
    case 'tool_use': {
      const detail = summarizeToolInput(ev.input);
      return detail ? `${ev.tool}: ${detail}` : ev.tool;
    }
    case 'activity':
      return ev.text;
    case 'final_result':
      return null; // terminal — the engine clears activity itself
  }
}

/** A short, single-line peek at a tool's input for the activity line. */
function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input);
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const key = obj.path ?? obj.file ?? obj.command ?? obj.cmd ?? obj.query;
    if (typeof key === 'string') return oneLine(key);
  }
  return '';
}

/** Flatten to one line and cap length so the activity is always a single row. */
function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

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
  /**
   * Resolve (and build) the concrete image the task runs in: the repo's dev
   * container or the frontmatter `image:` override, with the harness layered on.
   */
  resolveImage(repoPath: string, override: string | undefined, slug: string): Promise<string>;
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
    signal?: AbortSignal,
    onStdout?: (chunk: string) => void
  ): Promise<ExecResult>;
  stopContainer(containerId: string): Promise<void>;
  commitAll(repoPath: string, message: string, allowEmpty?: boolean): Promise<void>;
  diffChanges(repoPath: string): Promise<string>;
  /**
   * Run a command on the host worktree (not in a container). Used only for a
   * `hitl` subtask's approve-time verify, which runs no container. Optional so the
   * many container-only test rigs need not stub it; falls back to the real
   * host-exec when absent.
   */
  execHost?(cwd: string, cmd: string[]): Promise<ExecResult>;
}

const defaultDeps: EngineDeps = {
  createWorktree,
  removeWorktree,
  resolveImage: buildTaskImage,
  startContainer,
  execInContainer,
  stopContainer,
  commitAll,
  diffChanges,
  execHost,
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
  deps: EngineDeps,
  onEvent?: (ev: HarnessEvent) => void
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
      (cid, cmd, env, stdin, signal, onStdout) =>
        deps.execInContainer(cid, cmd, env, stdin, signal, onStdout),
      controller.signal,
      onEvent
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
  const commandRepo = new CommandRepository(db);
  const eventRepo = new EventRepository(db);
  const runHostVerify = deps.execHost ?? execHost;

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
  // The worktree is created up front because both the container path *and* the
  // host-side `hitl` approve path operate against it.
  const worktreePath = join(worktreesDir, task.slug);
  mkdirSync(worktreesDir, { recursive: true });
  await deps.createWorktree(repoPath, task.branch, worktreePath);

  // Lazy container: a task made entirely of `hitl` subtasks must start no
  // container and no harness at all, so the image is resolved and the container
  // started only when the first agent-backed subtask actually needs to run.
  // Memoized — every agent-backed subtask in the task reuses the one container.
  const containerLabel = taskLabel(task.slug);
  let containerId: string | undefined;
  async function ensureContainer(): Promise<string> {
    if (containerId) return containerId;
    // Image = the repo's dev container (or the frontmatter `image:` override) with
    // the harness layered on. Resolved against the worktree so it reflects the
    // task branch's toolchain.
    let image: string;
    try {
      image = await deps.resolveImage(worktreePath, task.image, task.slug);
    } catch (err) {
      throw new Error(
        `Image resolution failed for task '${task.slug}': ${err instanceof Error ? err.message : err}`
      );
    }
    try {
      // Bind the container to the worktree (not the repo root); no secrets at start
      // time — the API key is injected at `docker exec` time (see harness-adapter).
      containerId = await deps.startContainer(image, worktreePath, containerLabel, {});
    } catch (err) {
      throw new Error(`Container failed to start for task '${task.slug}': ${err}`);
    }
    return containerId;
  }

  // Graph nodes for the scheduler: stable slug + declared dependencies. The
  // scheduler is a pure function of (this graph, runtime state); the engine owns
  // all the I/O and the "halt on pause" policy around it.
  const nodes = task.subtasks.map(s => ({ slug: s.slug, blockedBy: s.blockedBy }));
  const bodyBySlug = new Map(task.subtasks.map(s => [s.slug, s]));

  const snapshot = (): Map<string, SubtaskStatus> => {
    const m = new Map<string, SubtaskStatus>();
    for (const s of task.subtasks) {
      m.set(s.slug, subtaskRepo.getStatus(subtaskRepo.findId(taskId, s.slug)));
    }
    return m;
  };

  // Notes a human attached to a `retry` command, injected into the re-run's first
  // attempt and consumed there.
  const retryNotes = new Map<string, string>();
  let aborted = false;

  /**
   * Run a hitl subtask's approve: run its declared verify on the host worktree (if
   * any), and — only if green — commit the human's changes (empty allowed) and
   * pass it. A red verify leaves the subtask `needs_human` for the human to fix.
   */
  async function approveHitl(sub: SubtaskSpec, id: number): Promise<void> {
    const verify = sub.verify.trim();
    const hasVerify = verify !== '' && verify.toLowerCase() !== 'none';
    if (hasVerify) {
      const res = await runHostVerify(worktreePath, ['sh', '-c', sub.verify]);
      if (res.exitCode !== 0) {
        const out = [res.stdout, res.stderr].filter(Boolean).join('\n');
        eventRepo.record(task.slug, sub.slug, 'approve_verify_failed', out);
        console.log(`  [${sub.slug}] approve verify failed — remains needs_human`);
        if (out) console.log(out);
        return;
      }
    }
    // Empty commit allowed: the human's work may have been a judgment or an
    // external action that left the worktree unchanged, but the approval still
    // earns a checkpoint on the branch.
    await deps.commitAll(worktreePath, `${task.slug}(${sub.slug}): approved`, true);
    subtaskRepo.setStatus(id, 'passed');
    console.log(`  [${sub.slug}] approved (hitl) — committed and continuing`);
  }

  /**
   * Apply one human command to a paused subtask. Action sets are gated by the
   * pause reason: a `hitl` pause accepts approve/skip/abort; a failure pause
   * accepts retry/skip/abort. An out-of-set action (e.g. `retry` on a hitl
   * subtask — there is no agent run to retry) is rejected, recorded, and the
   * subtask stays paused.
   */
  async function applyCommand(
    sub: SubtaskSpec,
    id: number,
    action: string,
    payload: string | null
  ): Promise<void> {
    const reason = sub.hitl ? 'hitl' : 'failure';
    const valid = sub.hitl
      ? action === 'approve' || action === 'skip' || action === 'abort'
      : action === 'retry' || action === 'skip' || action === 'abort';
    if (!valid) {
      eventRepo.record(task.slug, sub.slug, `command_rejected:${action}`, `invalid for a ${reason} pause`);
      console.log(`  [${sub.slug}] command '${action}' rejected (invalid for a ${reason} pause)`);
      return;
    }

    eventRepo.record(task.slug, sub.slug, `command:${action}`, payload ?? undefined);
    switch (action) {
      case 'retry':
        if (payload) retryNotes.set(sub.slug, payload);
        subtaskRepo.setStatus(id, 'pending');
        console.log(`  [${sub.slug}] retry${payload ? ' (with note)' : ''}`);
        break;
      case 'approve':
        await approveHitl(sub, id);
        break;
      case 'skip':
        // A skipped subtask does not satisfy `blockedBy`; the scheduler cascades
        // `blocked` to its dependents on the next pass.
        subtaskRepo.setStatus(id, 'skipped');
        console.log(`  [${sub.slug}] skipped`);
        break;
      case 'abort':
        aborted = true;
        taskRepo.setStatus(taskId, 'aborted');
        console.log(`  [${sub.slug}] abort — stopping task, keeping worktree + branch`);
        break;
    }
  }

  /**
   * Drain the command bus for every currently-paused subtask, applying the oldest
   * queued command for each (exactly once). Returns how many commands were
   * applied; the caller re-evaluates the schedule whenever this is > 0.
   */
  async function resolveCommands(): Promise<number> {
    let applied = 0;
    for (const sub of task.subtasks) {
      const id = subtaskRepo.findId(taskId, sub.slug);
      if (subtaskRepo.getStatus(id) !== 'needs_human') continue;
      const cmd = commandRepo.nextPending(task.slug, sub.slug);
      if (!cmd) continue;
      if (!commandRepo.consume(cmd.id)) continue; // lost a race — already consumed
      applied++;
      await applyCommand(sub, id, cmd.action, cmd.payload);
      if (aborted) break;
    }
    return applied;
  }

  /**
   * The per-subtask attempt → verify → commit/retry loop. Runs a fresh harness
   * each attempt over the partial changes still on disk (fix-forward); after K
   * attempts it returns false (escalate). A human `retry` note, if present, is
   * folded into this re-run's prompt.
   */
  async function runSubtask(cid: string, subtask: SubtaskSpec, subtaskId: number): Promise<boolean> {
    const note = retryNotes.get(subtask.slug);
    retryNotes.delete(subtask.slug);

    // Attempt 1 normally runs the raw body; a human `retry` note turns it into a
    // fix-forward prompt over the changes already on disk.
    let prompt = subtask.body;
    if (note) {
      const diff = await deps.diffChanges(worktreePath);
      prompt = assembleRetryPrompt({
        body: subtask.body,
        attempt: 1,
        maxAttempts: MAX_ATTEMPTS,
        verifyOutput: '',
        diff,
        note,
      });
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      subtaskRepo.setStatus(subtaskId, 'running');
      subtaskRepo.incrementAttempts(subtaskId);

      // Throttled live activity: stamp the agent phase from the harness stream so
      // the TUI's running indicator isn't an opaque black box. Throttling keeps
      // SQLite writes bounded no matter how fast the stream emits.
      subtaskRepo.setActivity(subtaskId, 'starting agent…', 'agent');
      let lastActivityAt = 0;
      const onEvent = (ev: HarnessEvent): void => {
        const line = activityLine(ev);
        if (line == null) return;
        const now = Date.now();
        if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
        lastActivityAt = now;
        subtaskRepo.setActivity(subtaskId, oneLine(line), 'agent');
      };

      const harnessResult = await runAttempt(cid, prompt, apiKey, attemptTimeoutMs, deps, onEvent);

      // Classify the attempt. A harness crash/timeout short-circuits; otherwise
      // the verify is authoritative — a self-reported success never overrides a
      // red verify.
      let outcome: FinalStatus;
      let verifyOutput = '';
      if (harnessResult.status === 'harness_error') {
        outcome = 'harness_error';
        verifyOutput = harnessResult.summary;
      } else {
        subtaskRepo.setActivity(subtaskId, oneLine(`verifying: ${subtask.verify}`), 'verify');
        const verifyResult = await deps.execInContainer(cid, ['sh', '-c', subtask.verify]);
        if (verifyResult.exitCode === 0) {
          outcome = 'passed';
        } else {
          outcome = 'verify_failed';
          verifyOutput = [verifyResult.stdout, verifyResult.stderr].filter(Boolean).join('\n');
        }
      }

      // The subtask is no longer actively running; drop the live activity so the
      // TUI doesn't show a stale line against a settled status.
      subtaskRepo.clearActivity(subtaskId);

      if (outcome === 'passed') {
        // One commit per passing subtask. The message encodes task + subtask slug
        // so the branch history is self-describing.
        await deps.commitAll(worktreePath, `${task.slug}(${subtask.slug}): passed`);
        subtaskRepo.setStatus(subtaskId, 'passed');
        console.log(`  [${subtask.slug}] passed (attempt ${attempt}/${MAX_ATTEMPTS})`);
        return true;
      }

      subtaskRepo.setStatus(subtaskId, outcome);
      console.log(`  [${subtask.slug}] ${outcome} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      if (verifyOutput) console.log(verifyOutput);

      // Persist the failure detail so the TUI's detail pane can show the verify
      // output / harness error for the selected subtask (otherwise it lives only
      // on the engine's stdout).
      eventRepo.record(
        task.slug,
        subtask.slug,
        `attempt_failed:${outcome}`,
        verifyOutput || undefined
      );

      // Fold any handoff fragment into the next attempt, then clear it so it can't
      // leak forward stale.
      const fragment = await readFragment(cid, deps);
      await clearFragment(cid, deps);
      if (fragment) eventRepo.record(task.slug, subtask.slug, 'fragment', fragment);

      if (attempt < MAX_ATTEMPTS) {
        const diff = await deps.diffChanges(worktreePath);
        prompt = assembleRetryPrompt({
          body: subtask.body,
          attempt: attempt + 1,
          maxAttempts: MAX_ATTEMPTS,
          verifyOutput,
          diff,
          fragment,
          note,
        });
      }
    }
    return false;
  }

  // A task with any agent-backed (non-`hitl`) subtask needs a container for this
  // run, so start it up front — this also surfaces an image-config error before
  // the loop and keeps the lifecycle uniform across resumes (even one that ends up
  // running nothing). A *pure*-`hitl` task takes neither branch: it starts no
  // container and no harness, exactly as a hitl pause requires.
  const hasAgentWork = task.subtasks.some(s => !s.hitl);
  if (hasAgentWork) await ensureContainer();

  // Cleanup disposition: only a clean, fully-completed run removes the worktree
  // (keeping the branch). A pause → needs_human, a skip, an abort, or a thrown
  // error all leave the worktree in place for inspection.
  let succeeded = false;
  try {
    while (true) {
      // Phase 1 — resolve any paused subtask via the command bus. Applying a
      // command (retry/approve/skip/abort) advances state, so re-evaluate.
      const applied = await resolveCommands();
      if (aborted) break;
      if (applied > 0) continue;

      // Phase 2 — schedule against the current state.
      const state = snapshot();
      const { runnable, blocked } = schedule(nodes, state);

      // Cascade: mark every transitive dependent of a non-passed subtask blocked.
      for (const slug of blocked) {
        if (state.get(slug) === 'blocked') continue;
        subtaskRepo.setStatus(subtaskRepo.findId(taskId, slug), 'blocked');
        console.log(`  [${slug}] blocked (a dependency did not pass)`);
      }

      // An unresolved pause halts the task: stop pulling new runnable work so an
      // independent subtask never races ahead of a pending human decision. The
      // cascade above has already run, so dependents end `blocked`, not `pending`.
      const paused = [...state.values()].some(s => s === 'needs_human');
      if (paused || runnable.length === 0) break;

      const subtask = bodyBySlug.get(runnable[0])!;
      const subtaskId = subtaskRepo.findId(taskId, subtask.slug);

      // A `hitl` subtask runs no harness and no container: pause immediately,
      // surfacing the authored body as the human's instructions, then loop back so
      // a queued command (approve/skip/abort) can resolve it.
      if (subtask.hitl) {
        subtaskRepo.setStatus(subtaskId, 'needs_human');
        eventRepo.record(task.slug, subtask.slug, 'needs_human:hitl', subtask.body);
        console.log(`  [${subtask.slug}] needs_human (hitl) — awaiting approve/skip/abort`);
        if (subtask.body) console.log(subtask.body);
        continue;
      }

      // Agent-backed subtask: start the container on first need, then run the loop.
      const cid = await ensureContainer();
      const passed = await runSubtask(cid, subtask, subtaskId);
      if (!passed) {
        subtaskRepo.setStatus(subtaskId, 'needs_human');
        eventRepo.record(
          task.slug,
          subtask.slug,
          'needs_human:failure',
          `escalated after ${MAX_ATTEMPTS} attempts`
        );
        console.log(`  [${subtask.slug}] needs_human after ${MAX_ATTEMPTS} attempts`);
        continue;
      }
    }

    // Success = the run wasn't aborted and every subtask passed. A `skipped`,
    // `blocked`, or `needs_human` subtask all mean unfinished work → keep the
    // worktree for inspection.
    succeeded =
      !aborted &&
      task.subtasks.every(
        s => subtaskRepo.getStatus(subtaskRepo.findId(taskId, s.slug)) === 'passed'
      );
  } finally {
    // Only stop a container that was actually started (a pure-hitl task starts none).
    if (containerId) await deps.stopContainer(containerId);

    // Success → remove the worktree, keep the branch (commits survive in the
    // shared object store). Any non-success exit keeps both for inspection.
    if (succeeded) {
      await deps.removeWorktree(repoPath, worktreePath);
    }
  }
}
