---
slug: arch-improvements
branch: refactor/architecture
---

# Task — Architecture deepening pass

## Why

The orchestrator is in good shape: deep modules, dependency-injected seams
(`EngineDeps`, `HarnessRunner`), and two proven harness adapters (pi, claude).
It does **not** need a service layer — DI already gives it the seam a service
layer would. The friction that remains is concentrated in a handful of leaky
seams and naming collisions, not in pervasive coupling.

This task deepens the seams that already exist and fixes the few places where
they leak. Each subtask is an independent, behaviour-preserving refactor: the
full test suite and a typecheck must stay green throughout. No feature change,
no new dependency.

## Guiding rules for every subtask

- **Behaviour-preserving.** `bun test` and `bunx tsc --noEmit` are the
  authority — they must pass before and after. Do not add or change features.
- **Deepen, don't wrap.** Prefer giving an existing module a small, sharper
  interface over introducing a new shallow pass-through layer.
- **One concern per commit.** Each subtask is its own commit on this branch.

## The six improvements (in subtask order)

1. **Event-type taxonomy** — give the engine↔TUI event-string protocol one owner.
2. **Rename scheduler collision** — `scheduler.ts` (graph) vs `task-scheduler.ts` (pool).
3. **Reconciler reset via repository** — stop bypassing `SubtaskRepository` with raw SQL.
4. **ExecResult + fragment to infra** — stop leaking container protocol into the engine.
5. **Split the harness adapter** — make pi and claude symmetric siblings.
6. **Consolidate policy constants** — one home for `MAX_ATTEMPTS` / `MAX_CONCURRENT_TASKS`.
