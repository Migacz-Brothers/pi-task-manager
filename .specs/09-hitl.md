---
slug: hitl
verify: bun test hitl && bunx tsc --noEmit
hitl: false
blockedBy: [retry]
---

# Slice 09 — Human-in-the-loop subtasks and the commands bus

## Value

Some steps are inherently human (rotate a key, click approve, make a judgment), and some
failures need a person. This slice makes human intervention a first-class, well-bounded part
of the sequence — driven through a simple SQLite command bus, never by blocking the agent
mid-run.

## Outcome

A `commands` table (the TUI→engine bus) carries human intents — `retry`, `approve`, `skip`,
`abort` (with optional note) — which the engine polls and applies. Authored `hitl: true`
subtasks pause with no container/harness running; the human works in the worktree and issues
`approve`, which runs any declared verify, commits (empty allowed), and continues. Failures
surface as `needs_human` with retry/skip/abort actions.

## Scope

- **State store**: add the `commands` table and a polling/consumption path in the engine.
- **HITL execution**: a `hitl: true` subtask runs **no harness and no container**; engine
  sets `needs_human`, surfaces the authored body as instructions, and waits.
- **Resolution actions**, with reason-specific action sets:
  - failure `needs_human` → `retry` (optional note injected into the next attempt) / `skip` /
    `abort`.
  - hitl `needs_human` → `approve` (run declared verify, then commit — empty allowed) /
    `skip` / `abort`.
- **`skip` cascade**: a skipped subtask does not satisfy `blockedBy`; dependents become
  `blocked`.

## Acceptance criteria

- A `hitl` subtask pauses without starting a container or harness and shows its instructions.
- `approve` on a hitl subtask runs its verify (if any), commits the human's worktree changes
  (empty commit allowed), and continues to dependents.
- `retry` with a note re-runs a failed subtask with the note included in the assembled
  context.
- `skip` marks the subtask skipped and cascades `blocked` to its dependents.
- `abort` stops the task and keeps worktree + branch.
- Commands are consumed exactly once and recorded in the event history.

## Edge cases

- `retry` is rejected/absent as an action for hitl subtasks (no agent run to retry).
- Two commands queued for one subtask → applied deterministically in order.

## Out of scope

- The TUI that issues these commands (10) — this slice exposes the bus; a test/CLI harness
  drives it here.

## Technical notes

- The agent never blocks mid-run; all human interaction happens at orchestrator boundaries.

## Depends on

- Slice 04 (retry).
