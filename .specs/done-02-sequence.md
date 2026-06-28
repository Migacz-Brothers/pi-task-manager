---
slug: sequence
verify: bun test sequence && bunx tsc --noEmit
hitl: false
blockedBy: [skeleton]
---

# Slice 02 — Sequential multi-subtask execution

## Value

A real task is more than one step. This slice runs an ordered set of subtasks within a
single task, committing after each, so the branch reads as a clean incremental history.

## Outcome

A task with several `NN-*.md` subtasks runs them in `NN-` order inside one container/branch;
each passing subtask produces one commit; the engine loads definitions by content and
re-seeds SQLite when a file changes.

## Scope

- Extend the **Spec Loader** to read all subtask files in a task and order them by `NN-`
  prefix; compute and store a **content hash** per file.
- Extend the **State store** to upsert subtask definitions keyed by stable id, detecting
  drift via content hash (re-seed on change). Frontmatter remains read-only to the engine.
- Extend the **Subtask runner** to iterate subtasks in order, committing per passing
  subtask, stopping the task on a non-passing subtask (no retry logic yet — that is 04).

## Acceptance criteria

- A task with N passing subtasks ends with N commits on the branch, in order.
- Editing a subtask file changes its content hash and the engine re-seeds that subtask.
- The engine never writes status back into the `.md` files (git tree stays clean).
- A failing subtask halts the task and leaves later subtasks unrun.

## Edge cases

- Duplicate `NN-` prefixes → deterministic, documented tiebreak (e.g. by filename).
- A subtask file added/removed between runs → reconciled on load.

## Out of scope

- `blockedBy` ordering and validation (03), retries (04), parallelism, TUI.

## Depends on

- Slice 01 (skeleton).

## Technical notes

- Commit message convention should encode the subtask slug so the branch history is
  self-describing and the engine can recognize its own checkpoints later.
