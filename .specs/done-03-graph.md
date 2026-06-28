---
slug: graph
verify: bun test graph && bunx tsc --noEmit
hitl: false
blockedBy: [sequence]
---

# Slice 03 — Dependency graph: blockedBy, validation, cascade

## Value

Ordering by filename is not enough — subtasks have real dependencies, and a step must never
run on a base where something it depends on failed. This slice makes dependencies explicit,
validated, and safe.

## Outcome

Subtasks declare `blockedBy: [slug, ...]` referencing sibling slugs. The engine validates
the graph at load, runs subtasks in topological order (with `NN-` as tiebreaker), runs a
subtask only when all its dependencies `passed`, and cascades a `blocked` state to
dependents when a dependency fails or is skipped.

## Scope

- **Spec Loader** validation: unique slugs within a task; every `blockedBy` entry resolves
  to a sibling slug; **no cycles** — any violation is a hard error and the task refuses to
  start.
- **Scheduler/Graph engine** (pure): compute the runnable set from graph + runtime state,
  topological order with `NN-` tiebreaker, and the cascade that marks dependents `blocked`
  when a dependency ends `failed`/`skipped`/`blocked`.
- Wire the scheduler into the subtask runner (replacing the naive sequential loop from 02).

## Acceptance criteria

- A subtask runs only after every `blockedBy` dependency is `passed`.
- A dependency ending non-`passed` cascades `blocked` to all transitive dependents.
- Unknown slug in `blockedBy`, duplicate slug, or a cycle → hard load error; task does not
  start.
- Topological order is respected; `NN-` prefix breaks ties deterministically.

## Edge cases

- Diamond dependencies (two deps of one subtask) resolve correctly.
- A self-referential `blockedBy` is rejected as a cycle.

## Out of scope

- Cross-task dependencies (explicitly out of scope for v1). Retries (04). Parallelism (07).

## Technical notes

- Keep the scheduler a **pure function** of (graph, state) → decisions, so it can be tested
  exhaustively in isolation. No I/O, no SQLite, no docker in this module.

## Depends on

- Slice 02 (sequence).
