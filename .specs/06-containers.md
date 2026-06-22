---
slug: containers
verify: bun test containers && bunx tsc --noEmit
hitl: false
blockedBy: [skeleton]
---

# Slice 06 — Container lifecycle, dev-container resolution, and auth

## Value

Tests must run in the repo's real toolchain, credentials must never leak into images or
branches, and idle containers must not hold resources during human waits. This slice makes
the container substrate faithful and lean.

## Outcome

Each task's container defaults to the repo's dev container (with a frontmatter `image:`
override), gets the API key injected as an environment variable at exec time, runs the agent
fully autonomously, and is alive only during active execution — torn down on pause or
completion, recreated on resume against the same worktree.

## Scope

- **Container manager**:
  - Image resolution: default to the repo's `.devcontainer`/Dockerfile; honor `image:`
    override from the main task frontmatter; layer the harness install on top.
  - **Auth**: inject `ANTHROPIC_API_KEY` (or the harness token) as an env var at
    `docker exec` time, sourced from host env / a gitignored secrets file. Never baked into
    the image or committed.
  - **Lifecycle B**: container alive only during active execution; torn down on
    pause/completion; resume = a fresh container on the same host-persisted worktree.
- Run the agent with **full tool auto-approval** (the container + branch + tests are the
  safety net).
- System-prompt instruction: **the engine owns git; the agent only edits files** (instruct-
  only enforcement for v1).

## Acceptance criteria

- With no `image:` set and a repo dev container present, verify runs in that toolchain.
- An `image:` override is honored.
- The API key is present in the agent's env at exec time and absent from the image and any
  commit.
- After a task pauses/completes, no container for it remains running; resuming starts a fresh
  one on the same worktree.
- The agent runs without per-tool permission prompts.

## Edge cases

- Repo has no dev container and no `image:` override → clear, actionable error.
- Missing API key/secret → fail fast with a clear message, not a confusing agent error.

## Out of scope

- Orphan reconciliation on crash (08). Parallel scheduling (07).

## Technical notes

- Label containers by task slug now — slice 08's orphan-kill depends on this label existing.
- Consult the vendored `pi` `containerization.md` for the headless/containerized run model.

## Depends on

- Slice 01 (skeleton).
