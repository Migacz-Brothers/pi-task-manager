---
slug: skeleton
verify: bun test skeleton && bunx tsc --noEmit
hitl: false
blockedBy: []
---

# Slice 01 — Walking skeleton: one subtask, end-to-end

## Value

Prove the whole pipe end-to-end with the thinnest possible path. One task, one subtask,
happy path only — but it cuts through every integration layer (spec parse → container →
harness → verify → git → SQLite). Everything else in this project is an increment on this
skeleton.

## Outcome

Running the engine against a `.specs/` dir containing one task (a `README.md` + a single
`NN-*.md` subtask) parses it, starts a container, runs the harness once on the subtask
body, runs the subtask's `verify` command, and — on green — makes one commit on the task's
branch and records `passed` in SQLite. Final status is printed to stdout.

## Scope

- Bun + TypeScript project scaffolding (`package.json`, `tsconfig.json`, test runner).
- Minimal **Spec Loader**: parse a task `README.md` (frontmatter: `slug`, `branch`) and one
  subtask file (frontmatter: `slug`, `verify`; body = prompt). No `blockedBy` yet.
- Minimal **State store**: SQLite schema for tasks/subtasks with status, plus open/migrate.
- Minimal **Harness adapter** (pi): spawn `pi --mode json` with the body as the prompt,
  consume the event stream, return a normalized `final_result`.
- Minimal **Container manager**: start a container from a fixed image, `docker exec` the
  harness and the verify command, tear down at the end.
- Minimal **Git manager**: ensure a branch exists, commit the worktree after verify passes.
- A CLI entrypoint that runs the queue once and prints status.

## Acceptance criteria

- Given a one-subtask task with a `verify` that passes, the engine ends with the subtask
  `passed` in SQLite and exactly one commit on the branch.
- The harness adapter normalizes the `pi --mode json` stream into a `final_result` with a
  terminal status.
- The verify command runs inside the container and its exit code decides pass/fail.
- A failing `verify` leaves the subtask non-`passed` and makes no commit (no retry yet —
  just records the failure).
- `bunx tsc --noEmit` is clean.

## Edge cases

- Missing/invalid frontmatter → a clear load-time error, engine refuses to run.
- Container fails to start → surfaced as an error, not a silent hang.

## Out of scope

- Retries, multiple subtasks, `blockedBy`, parallelism, TUI, worktrees, crash recovery,
  auth/dev-container resolution, the Claude adapter. All are later slices.

## Depends on

- Nothing. This is the foundation.

## Technical notes

- Stack: Bun + TS; tests with Vitest/`bun test` per the existing `pi` packages' convention.
- The harness adapter is the seam: define the common contract here (`task_started`,
  `tool_use`, `activity`, `final_result{status, summary}`) even if only pi is wired.
- Keep state external to the container from day one (SQLite + worktree on host) — the whole
  recovery story later depends on this being true now.
