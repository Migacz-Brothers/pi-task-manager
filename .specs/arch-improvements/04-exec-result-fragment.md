---
slug: exec-result-fragment
verify: bun test && bunx tsc --noEmit
hitl: false
blockedBy: []
---

# Lift `ExecResult` and the handoff-fragment protocol out of the engine

## Value

The engine expresses **container protocol as inline shell argv**: it hardcodes
`FRAGMENT_PATH` and issues raw `['cat', …]` / `['rm', '-f', …]` commands through
`execInContainer` to read and clear the agent's handoff fragment. "How you read a
handoff fragment" is container knowledge leaking into orchestration logic.
Separately, infra modules import `ExecResult` **up** from the adapter layer,
inverting the dependency direction (infra → adapter). Fixing both lets the engine
talk intent instead of shell, and lets the type live where it belongs.

## Current friction

- `src/engine.ts`: `FRAGMENT_PATH = '.orchestrator/handoff.md'` (around line 73),
  with inline `['cat', FRAGMENT_PATH]` (≈line 187) and `['rm', '-f', FRAGMENT_PATH]`
  (≈line 194) issued through `execInContainer`.
- `src/infra/container-manager.ts` and `src/infra/host-exec.ts` both import
  `ExecResult` from `src/harness-adapter.ts` — infra depending on the adapter
  layer for a type that is really a domain primitive.

## Outcome

- `ExecResult` lives in `src/types.ts` (a domain primitive); the adapter,
  container-manager, and host-exec import it from there. No infra → adapter type
  dependency remains.
- Reading and clearing the handoff fragment is a container-manager concern
  (e.g. `readFragment(...)` / `clearFragment(...)`) exposed through `EngineDeps`,
  so the engine no longer constructs `cat`/`rm` argv inline.

## Scope

- Move the `ExecResult` type definition to `src/types.ts`; update all imports
  (`harness-adapter.ts`, `container-manager.ts`, `host-exec.ts`, and any others).
- Add fragment read/clear functions to `container-manager.ts` (they own
  `FRAGMENT_PATH` and the argv), expose them via `EngineDeps`, and call them from
  the engine in place of the inline `execInContainer` calls.

## Acceptance criteria

- `bun test && bunx tsc --noEmit` passes.
- `engine.ts` no longer contains `FRAGMENT_PATH` or inline `cat`/`rm` argv for the
  fragment; it calls the injected fragment functions.
- No infra module imports a type from `harness-adapter.ts`.

## Out of scope

- The `['sh', '-c', subtask.verify]` verify invocation may stay in the engine for
  this slice (it's the verify runner's seam, not the fragment seam) — relocating
  it is optional and must not regress `tests/retry.test.ts`.

## Technical notes

- Keep the fragment functions behind `EngineDeps` so the existing fake-deps tests
  can inject them; default them to the real container-manager implementations.
