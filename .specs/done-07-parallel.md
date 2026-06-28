---
slug: parallel
verify: bun test parallel && bunx tsc --noEmit
hitl: false
blockedBy: [graph, isolation, containers]
---

# Slice 07 — Parallel task scheduling

## Value

Throughput: independent tasks should run at the same time, each fully isolated, without
overwhelming the machine or token budget.

## Outcome

The engine scans `.specs/` for tasks and runs up to **N=2** of them concurrently (a
script-level constant), each in its own container + worktree + branch, with subtasks
sequential within each task.

## Scope

- **Scheduler**: task-level concurrency cap (N=2 const); pick the next `pending` task when a
  slot frees; subtasks stay sequential within a task.
- Ensure isolation (05) and container lifecycle (06) hold under concurrency — no shared
  worktree, no container-name/label collisions, no SQLite write contention (WAL).
- One-shot run: the engine processes the queue until it drains (or all remaining tasks are
  `needs_human`), then exits.

## Acceptance criteria

- Given 3 independent tasks and N=2, at most 2 run at once; the third starts when a slot
  frees.
- Concurrent tasks land commits on their own branches with no cross-contamination.
- Concurrent status writes to SQLite do not corrupt or deadlock (WAL).
- The engine exits cleanly once the queue is drained.

## Edge cases

- More tasks than slots → queue ordering is deterministic.
- A task that immediately fails to start a container frees its slot for the next task.

## Out of scope

- Crash recovery / reconciliation (08). Cross-task dependencies (out of scope for v1).

## Technical notes

- N is a constant, not configuration surface, for v1.

## Depends on

- Slice 03 (graph), Slice 05 (isolation), Slice 06 (containers).
