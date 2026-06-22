---
slug: claude-adapter
verify: bun test claude-adapter && bunx tsc --noEmit
hitl: false
blockedBy: [retry]
---

# Slice 11 — Claude adapter (second harness)

## Value

The system promises "pi or any other harness." This slice proves the adapter seam is real by
adding a second harness behind the same common contract, so swapping the agent is a new
adapter — not a rewrite of the orchestrator.

## Outcome

A Claude adapter runs `claude -p … --output-format stream-json`, normalizes its event stream
into the same common contract used by the pi adapter (`task_started`, `tool_use`, `activity`,
`final_result{status, summary}`), and is selectable as the harness for a task — exercising
the exact same execution, verify, retry, and HITL paths.

## Scope

- **Harness adapter (Claude)**: spawn `claude -p` with `--output-format stream-json`, parse
  the event stream, map to the common contract including the three terminal outcomes.
- Harness selection: a mechanism to choose pi vs Claude per run/task (e.g. a constant or a
  task field), defaulting to pi.
- Confirm the agent runs non-interactive with auto-approved permissions inside the container.

## Acceptance criteria

- A task executed with the Claude adapter completes the same end-to-end path as with pi
  (parse → container → harness → verify → commit / retry / needs_human).
- The Claude stream normalizes to the identical common contract (verified against recorded
  fixtures).
- Switching harness requires no change to the scheduler, runner, verify, or git layers.

## Edge cases

- Claude-specific stream events with no pi equivalent map cleanly (or are ignored) without
  breaking the contract.
- Auth/permission flags differ from pi but still yield a non-interactive, auto-approved run.

## Out of scope

- Any third harness; per-subtask model selection.

## Technical notes

- Test via **recorded event-stream fixtures** for both harnesses, asserting both normalize to
  the same contract — this is the core regression guard for the adapter seam.

## Depends on

- Slice 04 (retry) — needs the common contract and outcome taxonomy in place.
