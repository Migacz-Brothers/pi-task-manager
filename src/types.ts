export type FinalStatus = 'passed' | 'verify_failed' | 'harness_error';

export type SubtaskStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'verify_failed'
  | 'harness_error'
  | 'blocked'
  | 'needs_human'
  | 'skipped';

/**
 * Human intents carried on the `commands` bus (TUI/CLI → engine). Action sets are
 * gated by the pause reason: a failure `needs_human` accepts `retry`/`skip`/`abort`;
 * an author-marked `hitl` `needs_human` accepts `approve`/`skip`/`abort`.
 */
export type CommandAction = 'retry' | 'approve' | 'skip' | 'abort';

export type HarnessEvent =
  | { type: 'task_started' }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'activity'; text: string }
  | { type: 'final_result'; status: FinalStatus; summary: string };

export interface FinalResult {
  status: FinalStatus;
  summary: string;
}

export interface SubtaskSpec {
  slug: string;
  verify: string;
  hitl: boolean;
  blockedBy: string[];
  body: string;
  contentHash: string;
  filePath: string;
}

export interface TaskSpec {
  slug: string;
  branch: string;
  image?: string;
  /**
   * Which agent harness runs this task's subtasks (`pi` | `claude`). Optional;
   * the engine falls back to the default harness (pi) when unset or unknown.
   */
  harness?: string;
  subtasks: SubtaskSpec[];
  dir: string;
}
