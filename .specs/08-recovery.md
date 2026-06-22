---
slug: recovery
verify: bun test recovery && bunx tsc --noEmit
hitl: false
blockedBy: [parallel]
---

# Slice 08 — Crash recovery and reconciliation

## Value

Long unattended runs must survive a crash, Ctrl-C, or laptop sleep without corruption or
leaked resources. Because all durable state is external (worktree, SQLite, transcripts),
recovery is reconciliation, not checkpointing.

## Outcome

On startup the engine reconciles against SQLite: subtasks marked `running` with no live
container are reset and re-run (safe, since every attempt is fresh + fix-forward), and
orphaned containers (labeled by task slug) are killed. Then the queue resumes.

## Scope

- **Recovery/reconciler** (startup):
  - Find SQLite rows in `running` with no corresponding live container → reset to `pending`
    (or `harness_error`) so they re-run.
  - Enumerate containers labeled by task slug; kill any with no active engine ownership.
  - Resume the queue from SQLite state.
- Ensure re-running an interrupted subtask is idempotent given fresh-run + fix-forward.

## Acceptance criteria

- Killing the engine mid-subtask and restarting re-runs exactly that subtask, with no
  duplicate commits and no corruption.
- Orphaned containers from a prior run are cleaned up on startup.
- A completed-and-committed subtask is not re-run after a restart.
- Worst case after any crash is one interrupted subtask re-running.

## Edge cases

- Engine dies between "verify passed" and "commit recorded" → reconciliation detects the
  missing commit/row and re-runs or repairs deterministically.
- Stale worktree from a crashed task → reconciled with the isolation rules.

## Out of scope

- A supervisor/daemon or auto-restart. Recovery happens on the next manual invocation.

## Technical notes

- This slice is the payoff for keeping all state external since slice 01 — no new state store
  is needed, only reconciliation logic.

## Depends on

- Slice 07 (parallel).
