---
slug: split-harness-adapter
verify: bun test && bunx tsc --noEmit
hitl: false
blockedBy: [exec-result-fragment]
---

# Make pi and claude symmetric harness siblings

## Value

The adapter seam is real and proven — two harnesses (pi, claude) sit behind the
identical `HarnessRunner` contract. But the file structure hides that pi is
special-cased: `harness-adapter.ts` is simultaneously the shared **contract**,
the shared **NDJSON plumbing**, *and* the **pi adapter**, while claude gets its
own file. The asymmetry makes the seam harder to see and makes "add a third
harness" non-obvious. Splitting it gives the seam a visible, symmetric shape.

## Current friction

- `src/harness-adapter.ts` defines `ExecFn`, `HarnessRunner`, `EventNormalizer`,
  the NDJSON machinery (`parseStream`, `makeStreamConsumer`), shared constants
  (`ENGINE_OWNS_GIT_INSTRUCTION`, `toFinalStatus`) — and also the concrete
  `runPiHarness` (around line 173).
- `src/claude-adapter.ts` imports that plumbing and adds `normalizeClaudeEvents` +
  `runClaudeHarness`.
- `src/harness-registry.ts` selects between them.

## Outcome

The harness layer is a set of symmetric files: one shared contract/plumbing
module that knows nothing about a specific harness, and one file per adapter.
Suggested shape:

- `src/harness/contract.ts` — types, `parseStream`/`makeStreamConsumer`, shared
  constants, `toFinalStatus`.
- `src/harness/pi.ts` — `runPiHarness` + pi normalization.
- `src/harness/claude.ts` — `runClaudeHarness` + claude normalization.
- `src/harness/registry.ts` — `selectHarness`, `REGISTRY`, `DEFAULT_HARNESS`.

(Flat `src/harness-*.ts` names are acceptable too; the point is symmetry, not the
exact directory.)

## Acceptance criteria

- `bun test && bunx tsc --noEmit` passes (`tests/claude-adapter.test.ts` covers
  the contract-parity fixtures and registry selection).
- pi and claude live in sibling files; neither adapter is embedded in the shared
  contract module.
- The shared module imports nothing harness-specific.

## Out of scope

- Adding a third harness, or changing the common contract / normalization
  behaviour. Pure restructuring of where the existing code lives.

## Depends on

- `exec-result-fragment` — that slice relocates `ExecResult` out of the adapter
  file first, so this split isn't fighting the same imports.

## Technical notes

- Prefer `git mv` where a file moves wholesale; keep the public exports stable so
  importers (`engine.ts`, registry) change only their import paths.
