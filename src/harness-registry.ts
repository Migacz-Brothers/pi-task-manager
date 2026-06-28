import type { HarnessRunner } from './harness-adapter.ts';
import { runPiHarness } from './harness-adapter.ts';
import { runClaudeHarness } from './claude-adapter.ts';

/** The harnesses the orchestrator can drive behind the common contract. */
export type Harness = 'pi' | 'claude';

/** pi unless explicitly told otherwise, per the slice's default. */
export const DEFAULT_HARNESS: Harness = 'pi';

const REGISTRY: Record<Harness, HarnessRunner> = {
  pi: runPiHarness,
  claude: runClaudeHarness,
};

export function isHarness(name: unknown): name is Harness {
  return name === 'pi' || name === 'claude';
}

/**
 * Resolve the runner for a run. Accepts an ordered list of candidate names
 * (e.g. the task's frontmatter field, then a run-level override) and returns the
 * first recognized one, falling back to {@link DEFAULT_HARNESS}. Selecting a
 * harness is the only change needed to swap agents — nothing in the scheduler,
 * runner, verify, or git layers is aware of which one was chosen.
 */
export function selectHarness(...candidates: Array<string | undefined>): HarnessRunner {
  for (const name of candidates) {
    if (isHarness(name)) return REGISTRY[name];
  }
  return REGISTRY[DEFAULT_HARNESS];
}
