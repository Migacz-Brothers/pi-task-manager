# PRD — Containerized task-queue orchestrator (pi-task-manager)

> A TUI-driven system that executes a queue of file-defined tasks by running a coding
> agent (pi, or any harness) inside a per-task Docker container, gating each step on
> tests, retrying with context on failure, and pausing for a human at well-defined points.

## Problem Statement

As a developer, I want to hand off a queue of well-specified coding tasks to an AI agent
and have them executed unattended, reliably, and in isolation — without me babysitting an
interactive chat for each one. Today, driving a coding agent means sitting in an
interactive session, re-pasting context when it fails, manually running tests after it
finishes, and having no structured way to express "do these steps in this order, stop and
ask me here, retry there." There is also no isolation: an agent working on several things
at once would clobber my working tree, and a crash or a closed terminal loses all progress.

I want the *orchestration* (ordering, retries, test-gating, human pauses, isolation) to be
owned by a deterministic script — not by the AI — while the AI lives sandboxed inside a
container and only edits files.

## Solution

A two-part system operating on a single target git repository:

- A **headless engine** that scans a `.specs/` directory for tasks, runs up to N tasks in
  parallel — each in its own Docker container, git worktree, and branch — and executes each
  task's subtasks in dependency order. For every subtask it runs a fresh single-shot harness
  invocation, then runs that subtask's test command. On a green test it commits; on a red
  test or a crash it retries (fresh run, fixing forward, with failure context assembled from
  test output + diff + an optional agent-written fragment) up to a fixed limit, then pauses
  for a human. Author-marked human-in-the-loop subtasks pause for a person to act. All
  durable state lives outside the container (worktree on host, SQLite, transcript files), so
  the engine survives crashes and restarts by reconciling against SQLite.

- A **thin TUI** (built with `pi-tui`) that is a pure view over the engine's SQLite state:
  a two-pane master/detail tree showing each task, its subtasks (by slug), live status, the
  currently-running step and its one-line activity, and a detail pane with verify output and
  failure fragments. The human controls the run by issuing commands (retry / approve / skip
  / abort) that the TUI writes into a SQLite `commands` table the engine consumes.

Tasks are authored as Markdown files with YAML frontmatter for structured fields and a prose
body that becomes the agent's prompt. The agent runs fully autonomously inside the container
(the container + branch + tests are the safety net); the engine owns git exclusively.

## User Stories

1. As a developer, I want to define a task as a directory of Markdown files, so that I can
   author and review work for the agent using my normal editor and git diff.
2. As a developer, I want each subtask's prompt to be plain Markdown prose, so that I can
   write rich instructions without escaping them into a config blob.
3. As a developer, I want structured fields (slug, verify command, hitl flag, blockedBy) in
   frontmatter, so that the engine can parse a verifiable structure while the body stays free-form.
4. As a developer, I want the engine to validate my task files at load time (unique slugs,
   resolvable `blockedBy`, no dependency cycles), so that a malformed task refuses to start
   instead of failing halfway through.
5. As a developer, I want a stable author-defined `slug` per file, so that dependencies
   between subtasks reference a name I control rather than a fragile filename or path.
6. As a developer, I want to declare `blockedBy` between sibling subtasks, so that a subtask
   only runs once the work it depends on has actually passed.
7. As a developer, I want a subtask whose dependency failed (or was skipped) to be
   automatically marked blocked, so that no step ever runs on top of a broken base.
8. As a developer, I want each task to run in its own Docker container, so that parallel
   tasks cannot interfere with each other.
9. As a developer, I want each task to run on its own git worktree and branch, so that the
   agent's changes are isolated and I can review and merge them deliberately.
10. As a developer, I want the branch name to come from the task's frontmatter, so that I
    control how the resulting branch is named before any work begins.
11. As a developer, I want one git commit per completed subtask, so that the branch reads as
    a clean, reviewable history of incremental progress.
12. As a developer, I want the container to default to my repo's existing dev container, so
    that tests run in the real toolchain, with a frontmatter override when I need a
    different image.
13. As a developer, I want my API key injected as an environment variable at exec time, so
    that credentials never get baked into an image or committed to a branch.
14. As a developer, I want each subtask gated by a test command, so that "the agent said it
    was done" is never trusted over "the tests actually pass."
15. As a developer, I want to mark a subtask as unverified explicitly (`verify: none`), so
    that planning/scaffolding steps are allowed — but I want them flagged loudly, never
    passed silently.
16. As a developer, I want a failed subtask to be retried automatically with context, so
    that transient or near-miss failures resolve without my intervention.
17. As a developer, I want each retry to be a fresh agent run that fixes forward over the
    partial changes still on disk, so that retries are simple and stateless yet build on
    prior progress.
18. As a developer, I want the engine to assemble retry context from the failing test
    output, a diff of what changed, and any fragment the agent wrote, so that the next
    attempt has everything it needs without me re-pasting anything.
19. As a failing agent, I want to write a short "what went wrong" fragment to a known path,
    so that the next attempt can read my reasoning.
20. As a developer, I want a fixed retry limit (K=2) after which the task pauses for me, so
    that the system never burns tokens looping forever on something it can't solve.
21. As a developer, I want to see which task and subtask is running right now, so that I
    always know what the system is doing.
22. As a developer, I want a live one-line activity for the running subtask, so that an
    in-progress step isn't an opaque black box.
23. As a developer, I want a two-pane tree of tasks and subtasks with status glyphs and the
    attempt counter, so that I can scan overall progress at a glance.
24. As a developer, I want to inspect a subtask's verify output and failure fragment in a
    detail pane, so that I can understand a failure before deciding what to do.
25. As a developer, I want to author human-in-the-loop subtasks, so that manual steps
    (rotate a key, click approve, do something the agent can't) are first-class parts of the
    sequence.
26. As a developer, I want a hitl subtask to pause with my own instructions shown and no
    agent or container running, so that I can do the manual work in the worktree and then
    continue.
27. As a developer, I want to approve a paused hitl subtask (optionally running its verify
    and committing my changes), so that my manual work is recorded just like an agent's.
28. As a developer, I want the agent to never block mid-run waiting on me, so that humans
    are only pulled in at clean orchestrator boundaries.
29. As a developer, I want to resume a failed subtask with a free-text note, so that I can
    nudge the next attempt with guidance.
30. As a developer, I want to skip a paused subtask, so that I can move past something I've
    decided is unnecessary — understanding its dependents will also be blocked.
31. As a developer, I want to abort a task, so that I can stop a run while keeping its branch
    and worktree for inspection.
32. As a developer, I want up to two tasks running in parallel by default (a configurable
    constant), so that I get throughput without overwhelming my machine or token budget.
33. As a developer, I want the engine to run once through the queue and exit, so that runs
    are predictable and I am not running a daemon I have to manage.
34. As a developer, I want a per-attempt timeout, so that a hung agent run is killed and
    counted as a failure rather than stalling the queue forever.
35. As a developer, I want the agent to run fully autonomously inside the container, so that
    I'm not approving individual tool calls for unattended work.
36. As a developer, I want the engine to own all git operations and the agent to only edit
    files, so that the commit-per-subtask history stays clean and predictable.
37. As a developer, I want the engine to survive a crash, Ctrl-C, or laptop sleep, so that
    a long run is never corrupted — at worst one interrupted subtask re-runs.
38. As a developer, I want orphaned containers to be cleaned up on restart, so that a crash
    doesn't leave resources leaking.
39. As a developer, I want a finished task to leave a ready-to-merge branch (worktree
    removed, branch kept), so that my repo stays tidy and the result is clear.
40. As a developer, I want the system to drive pi by default and Claude (or another harness)
    through an adapter, so that I can swap the agent without rewriting the orchestrator.
41. As a developer, I want the TUI to be a pure reader of state that I can close without
    stopping the work, so that the engine keeps running headlessly (e.g. in CI) without a UI.
42. As a developer, I want task definitions to stay clean in git (status never written back
    into frontmatter), so that running a task doesn't dirty my tree or cause merge conflicts.

## Implementation Decisions

**Vocabulary & topology**
- A **task** is a `.specs/<task>/` directory: one container, one branch, one worktree.
- A **subtask** is a `NN-*.md` file: one fresh single-shot harness run + one verify step.
- Operates on a **single target repo**. Up to **2 tasks in parallel** (script-level
  constant). Subtasks within a task are **topologically ordered by `blockedBy`**, with the
  `NN-` filename prefix as a tiebreaker.

**Process architecture**
- **Split** into a headless **engine** (sole writer of execution state) and a thin **TUI**
  client, communicating **through SQLite (WAL mode)** — no socket protocol. The engine
  writes state + a throttled one-line activity; the TUI writes intents into a `commands`
  table the engine polls.
- Stack: **Bun + TypeScript**; TUI built with **`@earendil-works/pi-tui`**.

**Source-of-truth split**
- **Definitions** live in `.md` files in git. **Frontmatter is read-only to the engine**
  (load-only); a **content hash** detects edits. Body = the harness prompt.
- **Runtime state** lives in **SQLite** (status, attempts, timings, current activity).
- **Transcripts and the failure fragment** are flat files (one `.jsonl` per attempt),
  referenced by path from SQLite. Recommended location: a gitignored `.specs/.state/`.

**File format**
- Main task descriptor `README.md` frontmatter: `slug`, `branch` (required), `image`
  (optional; default = repo dev container).
- Subtask frontmatter: `slug` (unique within task; the `blockedBy` identity), `verify`
  (command; `none` allowed but flagged loudly), `hitl` (bool), `blockedBy` (array of
  sibling slugs).
- **Load-time validation**: unique slugs, every `blockedBy` resolves to a sibling, **no
  cycles** — otherwise a hard error and the task refuses to start.
- Deliberately excluded from v1 frontmatter: `retry`, `timeout`, task-level verify,
  cross-task dependencies.

**Execution & harness**
- Engine drives the harness as a subprocess via `docker exec`, reading a JSON event stream
  normalized by a per-harness **adapter** to a common contract (`task_started`, `tool_use`,
  `activity`, `final_result{status, summary}`). **pi adapter = `pi --mode json`**
  (single-shot — fits fresh-run-per-attempt); **Claude adapter = `--output-format
  stream-json`**. pi is the primary harness.
- Container = repo's dev container (frontmatter `image:` override), with the harness layered
  on. **API key injected as an env var at exec time** (never baked or committed).
- Agent runs **fully autonomous** inside the container. **Engine owns git exclusively; the
  agent only edits files** — enforced by instruction (system prompt) for v1.

**Success / failure / retry**
- **Tests are the authority.** Three outcomes per subtask: `harness_error` (crash / timeout
  / limit), `verify_failed` (tests red), `passed`.
- `passed` → **one commit on the task branch**.
- Failure → retry as a **fresh run, fixing forward** (partial edits remain in the worktree).
  Engine assembles retry context = **failing verify output + diff + optional agent fragment**
  (conventional path, e.g. `.orchestrator/handoff.md`, read then cleared).
- Retry limit **K = 2** (script constant). After K → `needs_human`, halt the task.
- **Per-attempt wall-clock timeout** (script constant, ~20 min); hang → `harness_error`.

**Human-in-the-loop**
- Two pause triggers, both → `needs_human`: **failure after K** and **author-marked
  `hitl: true`**. The agent never blocks mid-run.
- A `hitl` subtask runs **no harness and no container**; the human works in the host
  worktree; **`approve_hitl`** → run any declared verify → commit (empty allowed) → continue.
- Action sets by pause reason: failure → `retry` / `skip` / `abort`; hitl → `approve` /
  `skip` / `abort`. A **`skip` cascades** — it does not satisfy `blockedBy`, so dependents
  become `blocked`.

**Lifecycle & recovery**
- Container is **alive only during active execution**; torn down on pause/completion; resume
  = a fresh container on the same host-persisted worktree.
- **Crash recovery (v1):** on startup, reconcile against SQLite — orphaned `running` rows
  re-run; containers labeled by task slug are killed; the queue resumes from SQLite.
- **Cleanup:** abort/pause keeps worktree + branch; **success removes the worktree, keeps
  the branch** for the human to merge.

**Deep modules (build/modify)**
1. **Spec Loader/Parser** — `.specs/<task>/` → validated task graph (frontmatter, slugs,
   `blockedBy`, cycle detection, content hashes). Pure: filesystem in, validated graph out.
2. **Scheduler/Graph engine** — runnable-set computation: topo order, `blockedBy` gating,
   skip/fail cascade, N=2 concurrency. Pure logic.
3. **State store** — SQLite runtime state + the `commands` bus (WAL).
4. **Harness adapter** — normalizes `pi --mode json` / Claude `stream-json` streams to the
   common event contract.
5. **Container manager** — container lifecycle, worktree/branch setup, orphan reconciliation.
6. **Git/worktree manager** — worktree+branch per task, commit-per-subtask, cleanup.
7. **Verify runner** — runs the verify command in-container, captures exit + output.
8. **Context assembler** — builds the retry prompt from verify output + diff + fragment. Pure.
9. **Subtask runner** — the per-subtask attempt → verify → commit/retry → needs_human loop.
10. **Recovery/reconciler** — startup reconciliation + orphan-kill.
11. **TUI** — `pi-tui` client: reads SQLite state, renders the tree/detail, writes commands.

## Testing Decisions

A good test exercises **external behavior through a module's public interface**, not its
internal implementation — given inputs produce expected outputs/state, with no assertions on
private structure, so the tests survive refactors. The pure and adapter modules are the
highest-value, most isolatable targets and will be tested:

- **Spec Loader/Parser** — feed fixture `.specs/` directories and assert the resulting
  validated graph: correct frontmatter parsing, unique-slug enforcement, `blockedBy`
  resolution, cycle detection (rejected), content-hash drift detection, and clear errors for
  malformed input. Tested as a pure function over fixture directories.
- **Scheduler/Graph engine** — given a graph + runtime state, assert the runnable set,
  topological ordering with `NN-` tiebreaker, the N=2 concurrency cap, and the cascade that
  marks dependents `blocked` when a dependency fails or is skipped. Pure-logic table tests.
- **Harness adapter** — replay **recorded event-stream fixtures** (`pi --mode json` and
  Claude `stream-json`) and assert they normalize to the same common contract, including
  the three terminal outcomes (`passed` / `verify_failed` / `harness_error`) and the
  one-line activity extraction.
- **Context assembler** — given verify output + a diff + an optional fragment, assert the
  assembled retry prompt contains exactly those pieces and degrades correctly when the
  fragment is absent. Pure function.

Prior art: the existing `pi` packages use **Vitest** (`"test": "vitest --run"`), so these
tests should follow that harness and the repo's existing fixture conventions.

Modules deferred from unit testing in v1 (validated manually / via integration): State
store, Container manager, Git/worktree manager, Verify runner, Subtask runner,
Recovery/reconciler, and the TUI — these are I/O- and side-effect-heavy and are better
covered by a small number of end-to-end runs than by brittle mocks.

## Out of Scope

- **Cross-task dependencies** (`blockedBy` across tasks) and the branch-merge ordering they
  would require. v1 is within-task only.
- **Task-level / definition-of-done verify** (a whole-task gate after all subtasks). Per-
  subtask verify only for v1; add later if needed.
- **Filesystem watch mode** / a persistent daemon. The engine is one-shot per invocation.
- **Hard enforcement of the git-ownership boundary** (blocking agent git writes). v1 relies
  on instruction in the system prompt; enforcement is a fast-follow.
- **Session resume / `--resume`.** Every retry is a fresh single-shot run by design.
- **Multiple target repos**, escalation ladders (fresh-session/model-bump on retry), and
  configurable retry counts in frontmatter (K is a constant).
- **Mid-run interactive agent prompts.** Humans intervene only at orchestrator boundaries.

## Further Notes

- The harness headless surface is confirmed to exist in the vendored `pi` packages:
  `print-mode` (`pi -p` text, `pi --mode json` event stream) and an `rpc` mode, plus an SDK
  export and a `containerization.md` doc — pi is explicitly built to run headless and
  containerized. The single-shot `--mode json` path aligns with fresh-run-per-attempt, so
  the persistent RPC server is not needed for v1.
- Two small details defaulted without explicit ruling, open to change: the state directory
  (`.specs/.state/`, gitignored) and the system name (currently `pi-task-manager`).
- The design is deliberately "dead simple" where it counts: SQLite-as-bus instead of a
  protocol, fresh-run retries instead of session management, externalized state so recovery
  is reconciliation rather than checkpointing, and constants (K, concurrency, timeout)
  instead of configuration surface.
- A fitting bootstrap: author this PRD's modules as the system's own first `.specs/` task so
  the orchestrator can build itself.
