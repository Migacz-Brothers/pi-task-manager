---
slug: tui
verify: bunx tsc --noEmit
hitl: false
blockedBy: [hitl]
---

# Slice 10 — TUI: live tree, activity, and controls

> Process note: this slice is **HITL for development** — it requires a human **design
> review** of the rendered interface before merge. The frontmatter `hitl` flag is `false`
> because the system's runtime semantics define `hitl: true` as "no agent runs" (a pure
> human step), which would prevent the agent from building the TUI. The design-review gate is
> a process step, captured here and in the acceptance criteria, not a runtime pause.

## Value

A developer needs to see what the system is doing and steer it. This slice delivers the
observable, controllable surface: which task/subtask is running now, live activity, and the
actions to resume/approve/skip/abort.

## Outcome

A `pi-tui` client that is a pure reader of SQLite for display and a writer of the `commands`
bus for control: a two-pane master/detail tree of tasks → subtasks (by slug) with status
glyphs, attempt counter, the currently-running indicator, a live one-line activity, and a
detail pane showing verify output and failure fragments, plus an action bar.

## Scope

- **Engine**: write a throttled one-line `current_activity` (+ phase) onto the running
  subtask's row as it consumes the harness stream.
- **TUI** (`@earendil-works/pi-tui`):
  - Left pane: task/subtask tree with slugs, status glyphs (`pending / running⟳ / passed✓ /
    failed✗ / blocked / needs_human⚠ / skipped`), `X/Y` progress, attempt `1/2`, spinner on
    the active subtask.
  - Right pane: live activity for the running subtask, verify output on completion, failure
    fragment on failure, and the authored instructions for hitl pauses.
  - Action bar issuing `commands` (reason-specific: retry/approve/skip/abort + optional note).
  - Poll SQLite on a timer (~250 ms); never write execution state, only `commands`.
- Closing the TUI must not stop the engine.

## Acceptance criteria

- The tree shows every task/subtask with correct live status and highlights the running one.
- The running subtask shows the engine's one-line activity, updating as it works.
- The detail pane shows verify output / fragment / hitl instructions per the selected node.
- The action bar writes the correct command rows; the engine acts on them.
- Quitting the TUI leaves the engine running.
- **A human design review of the rendered TUI is completed and signed off before merge.**
- `bunx tsc --noEmit` is clean.

## Edge cases

- Narrow terminals: tree rows and activity truncate responsively without wrapping garbage.
- Many tasks/subtasks: the tree scrolls and stays responsive.

## Out of scope

- A web UI or alternative front-ends (the SQLite-reader contract makes these possible later).

## Technical notes

- Mirror the existing `tool-tester` TUI's structure and the `pi-tui` primitives (`Text`,
  `Container`, `Markdown`, `Spacer`).

## Depends on

- Slice 09 (hitl + commands bus).
