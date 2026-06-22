---
slug: isolation
verify: bun test isolation && bunx tsc --noEmit
hitl: false
blockedBy: [skeleton]
---

# Slice 05 — Per-task isolation: worktree + branch

## Value

Parallel tasks must not clobber each other, and every task's output must be a clean,
reviewable artifact. Git worktrees + a branch per task give isolation without copying the
repo, and keep all changes inspectable on the host.

## Outcome

Each task runs on its own git **worktree** and **branch** (named from the main task
frontmatter). The container is bound to that worktree. Cleanup follows the agreed rules:
success removes the worktree but keeps the branch; abort/pause keeps both.

## Scope

- **Git/worktree manager**: create a worktree + branch (`branch:` from task frontmatter) at
  task start; bind it into the container; commit-per-subtask lands on that branch.
- Cleanup rules:
  - **success** → tear down container, **remove worktree, keep branch** (commits live in
    `.git`).
  - **abort / needs_human / pause** → **keep worktree + branch** for inspection.
- Make the skeleton's git/commit path branch- and worktree-aware (replacing any fixed-branch
  assumption from 01).

## Acceptance criteria

- A task creates a worktree on the frontmatter-named branch; commits land there.
- On success the worktree is removed and the branch remains with all commits intact.
- On abort or `needs_human` the worktree and branch both remain.
- Two tasks on different branches do not share or corrupt each other's working tree.

## Edge cases

- Branch name already exists → documented behavior (reuse vs error).
- Stale worktree left from a prior crashed run → reconciled (overlaps with slice 08).

## Out of scope

- Concurrency scheduling itself (07) and orphan reconciliation (08) — this slice just makes
  isolation correct for a single task.

## Technical notes

- Worktrees share one `.git` object store, so removing a worktree never loses commits — rely
  on this for the success-cleanup rule.

## Depends on

- Slice 01 (skeleton).
