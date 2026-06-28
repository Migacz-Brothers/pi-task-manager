---
slug: retry
verify: bun test retry && bunx tsc --noEmit
hitl: false
blockedBy: [sequence]
---

# Slice 04 — Failure taxonomy, retries, and context assembly

## Value

The whole point of unattended execution: when the agent fails, the system retries with
useful context instead of giving up or looping forever. This slice makes failure a
first-class, bounded, context-carrying event.

## Outcome

Each subtask attempt resolves to one of three outcomes — `harness_error` (crash / timeout /
limit), `verify_failed` (tests red), or `passed`. On failure the engine retries with a
**fresh** harness run that fixes forward over the partial changes still on disk, feeding it
context assembled from the failing verify output, a diff of the attempt's changes, and any
fragment the agent wrote. After **K=2** attempts the subtask becomes `needs_human` and the
task halts.

## Scope

- **Subtask runner**: classify each attempt into the three outcomes; enforce a per-attempt
  wall-clock **timeout** (script const, ~20 min) → `harness_error`.
- **Context assembler** (pure): build the retry prompt from `{verify output, diff, optional
  fragment}`, degrading gracefully when the fragment is absent.
- Fragment convention: the harness is instructed to write `.orchestrator/handoff.md`; the
  engine reads it into context and clears it before the next attempt.
- Retry loop: fresh run per attempt, fix-forward (keep worktree edits), K=2 const, then
  `needs_human` + halt task.
- Tests are authoritative: the agent's self-reported success never overrides a red verify.

## Acceptance criteria

- A `verify_failed` attempt triggers a fresh retry whose prompt contains the failing verify
  output and a diff of the changes.
- If the agent wrote a fragment, it is included in the retry context, then cleared.
- A hung attempt is killed at the timeout and counted as `harness_error`.
- After K=2 failed attempts the subtask is `needs_human` and the task halts (dependents do
  not run).
- An attempt where the agent claims success but verify is red is recorded as `verify_failed`.

## Edge cases

- Agent finishes confident but verify red → no fragment exists → context still assembled
  from verify output + diff.
- Empty diff on failure (agent changed nothing) → context still includes verify output.

## Out of scope

- HITL resume actions and the commands bus (09). Session resume / model escalation (out of
  scope for v1).

## Technical notes

- Keep the **context assembler** pure (inputs → prompt string) for isolated testing.
- K and the timeout are script-level constants, not frontmatter fields.

## Depends on

- Slice 02 (sequence). Composes with 03 (graph) for cascade-on-failure.
