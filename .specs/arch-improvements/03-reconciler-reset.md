---
slug: reconciler-reset
verify: bun test && bunx tsc --noEmit
hitl: false
blockedBy: []
---

# Route the reconciler's `running → pending` reset through `SubtaskRepository`

## Value

Every subtask write goes through `SubtaskRepository` — except one. Crash
recovery resets orphaned `running` rows back to `pending` with a **raw SQL
string inside the reconciler**, bypassing the repository that owns every other
subtask mutation. That's a split brain on "what is a subtask write," and it
duplicates the activity/phase-clearing logic the repo already expresses. Closing
this makes the recovery path testable through the repo interface and gives
subtask writes a single owner.

## Current friction

- `src/reconciler.ts` (around lines 53–58) issues a raw `UPDATE` that flips
  `running` → `pending` and clears `current_activity` / `current_phase`.
- `src/infra/db/subtask-repository.ts` already has `setStatus` and
  `clearActivity`, but no method for the bulk reset — so the recovery write lives
  outside the repository.

## Outcome

`SubtaskRepository` gains a method (e.g. `resetRunning()`) that performs the
`running → pending` reset and activity/phase clear. The reconciler calls it.
No raw SQL for subtask state remains in `reconciler.ts`.

## Scope

- Add `resetRunning()` (or similarly named) to `SubtaskRepository`, returning
  what the reconciler needs (e.g. the count or the reset slugs, matching the
  existing `{ resetSubtasks }` shape `reconcile()` returns).
- Replace the raw SQL in `reconciler.ts` with the repository call.

## Acceptance criteria

- `bun test && bunx tsc --noEmit` passes (`tests/recovery.test.ts` in
  particular still passes).
- `reconciler.ts` contains no raw SQL string for subtask state.
- All subtask-status writes go through `SubtaskRepository`.

## Out of scope

- The container-kill half of recovery (`killContainersByLabel`) stays as is —
  this slice only relocates the SQL write.
- Introducing a unified "store" facade over all repositories (noted elsewhere)
  is a separate concern, not part of this slice.

## Technical notes

- Keep the reconciler's existing return contract so its callers and tests don't
  need to change.
