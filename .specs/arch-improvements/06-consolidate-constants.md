---
slug: consolidate-constants
verify: bun test && bunx tsc --noEmit
hitl: false
blockedBy: []
---

# Consolidate the policy constants into one home

## Value

The "K/N" policy constants are declared independently in multiple files. Most
dangerously, `MAX_ATTEMPTS = 2` is defined in **both** the engine and the TUI:
if they ever drift, the TUI's `1/2` attempt counter quietly lies about what the
engine is doing. The PRD treats these (retry limit, concurrency, timeout) as
deliberate constants rather than configuration — so they should have one
authoritative home, not be copy-pasted across the seam.

## Current friction

- `src/engine.ts` (≈line 27): `MAX_ATTEMPTS = 2`.
- `src/tui.ts` (≈line 66): a second `MAX_ATTEMPTS = 2` driving the `1/2` display.
- `src/task-scheduler.ts` (≈line 8): `MAX_CONCURRENT_TASKS = 2`.
- The per-attempt timeout constant lives in the engine as well.

## Outcome

A single policy module (e.g. `src/policy.ts` or `src/config.ts`) exports the
orchestration constants — retry limit, concurrency cap, per-attempt timeout —
and every consumer imports from it. No constant is declared in two places.

## Scope

- Create the policy module and move `MAX_ATTEMPTS`, `MAX_CONCURRENT_TASKS`, and
  the per-attempt timeout into it.
- Update `engine.ts`, `tui.ts`, and `task-scheduler.ts` (and any other consumer)
  to import from it.

## Acceptance criteria

- `bun test && bunx tsc --noEmit` passes.
- `MAX_ATTEMPTS` is defined exactly once; `tui.ts` imports it rather than
  redeclaring it.
- All orchestration policy constants resolve to the single module.

## Out of scope

- Turning any of these into runtime/file configuration. The PRD deliberately
  keeps them as constants; this slice only centralizes them.

## Technical notes

- Keep the names and values identical to avoid any behaviour change — this is a
  move, not a retune.
