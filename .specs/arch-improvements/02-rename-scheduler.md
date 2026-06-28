---
slug: rename-scheduler
verify: bun test && bunx tsc --noEmit
hitl: false
blockedBy: []
---

# Resolve the `scheduler.ts` / `task-scheduler.ts` name collision

## Value

Two unrelated concerns share the "scheduler" name, so a reader (or an AI
navigating the tree) conflates them. The tests already disagree with the
filenames — `tests/graph.test.ts` covers `scheduler.ts` and
`tests/parallel.test.ts` covers `task-scheduler.ts` — which is the tell that the
domain names and the filenames have drifted. This is a pure legibility win with
no behaviour change.

## Current friction

- `src/scheduler.ts` is the **pure dependency-graph planner**: `schedule()`,
  `topologicalOrder`, `findCycle`, `isBlockingStatus`, `GraphCycleError`. It does
  no I/O — it's a planner, not a scheduler.
- `src/task-scheduler.ts` is the **concurrency worker pool**: `runQueue()` plus
  `MAX_CONCURRENT_TASKS`. It is the thing that actually schedules execution.

## Outcome

Each file's name matches what it is. Suggested:

- `src/scheduler.ts` → `src/dependency-graph.ts` (or `src/graph.ts`).
- `src/task-scheduler.ts` → `src/task-pool.ts` (or `src/run-queue.ts`).

All importers updated; tests still pass.

## Scope

- Rename both source files and update every import
  (`src/engine.ts`, `src/spec-loader.ts`, `src/index.ts`, and any others —
  `findCycle` is imported by the spec loader).
- Optionally rename the test files to match (`graph.test.ts` already fits the
  graph module; `parallel.test.ts` may become `task-pool.test.ts`). Not required
  as long as the suite stays green.

## Acceptance criteria

- `bun test && bunx tsc --noEmit` passes.
- No file is named `scheduler.ts` or `task-scheduler.ts` afterwards.
- No dangling imports of the old paths anywhere in `src/` or `tests/`.

## Out of scope

- Any change to the scheduling/graph logic itself, or moving code between the two
  modules. Pure rename + import fixups.

## Technical notes

- Prefer `git mv` so history follows the file.
