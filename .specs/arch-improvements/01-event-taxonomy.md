---
slug: event-taxonomy
verify: bun test && bunx tsc --noEmit
hitl: false
blockedBy: []
---

# Own the event-`type` string taxonomy in one place

## Value

The engine and the TUI communicate through an **implicit protocol**: the engine
writes event rows with ad-hoc `type` string literals, and the TUI re-parses them
with `startsWith`/equality to render pauses, failures, and activity. No module
owns this vocabulary, so changing a string in the engine silently breaks the
TUI — and nothing catches it, because neither entry point is tested. This is the
single most fragile seam in the codebase. Giving the taxonomy one owner is the
highest-value, lowest-risk fix in this pass.

## Current friction

- Engine writes literals like `needs_human:hitl`, `needs_human:failure`,
  `attempt_failed:<status>`, `fragment`, `command:<action>`,
  `command_rejected:<action>`, `approve_verify_failed` inline
  (see `src/engine.ts` around lines 455–540).
- TUI re-derives meaning by string-matching those same literals
  (see `src/tui.ts` around lines 156–182: `pauseReason`, `latestAttemptFailure`).

## Outcome

A single module owns the event taxonomy. The engine constructs event types
through it; the TUI classifies/parses event rows through it. The literal strings
appear in exactly one file. No event `type` string is hand-written in
`engine.ts` or `tui.ts` anymore.

## Scope

- Add a module (e.g. `src/events.ts`, or extend `src/types.ts` alongside
  `EventRepository`) that defines every event `type` the engine emits, with
  small constructors for the parameterized ones (`attempt_failed:<status>`,
  `command:<action>`, …) and matching parsers/classifiers the TUI uses.
- Replace the inline literals in `engine.ts` with the constructors.
- Replace the `startsWith`/equality parsing in `tui.ts` with the parsers.

## Acceptance criteria

- The full suite and typecheck pass (`bun test && bunx tsc --noEmit`).
- Grep confirms no event-`type` literal (e.g. `needs_human:`, `attempt_failed:`,
  `command:`) is constructed or parsed outside the new owner module.
- Engine emission and TUI interpretation both route through the shared module.

## Out of scope

- Changing the event schema, adding new event types, or altering what the TUI
  renders. This is a relocation of an existing vocabulary, not a redesign.

## Technical notes

- The win is **locality**: the event vocabulary becomes the test surface. A
  small unit test over the constructors/parsers (round-tripping the
  parameterized types) is welcome but optional for this slice.
