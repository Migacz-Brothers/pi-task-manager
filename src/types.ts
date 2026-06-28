export type FinalStatus = 'passed' | 'verify_failed' | 'harness_error';

export type SubtaskStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'verify_failed'
  | 'harness_error'
  | 'blocked'
  | 'needs_human';

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
  subtasks: SubtaskSpec[];
  dir: string;
}
