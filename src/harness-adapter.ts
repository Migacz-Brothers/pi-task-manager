import type { FinalResult, FinalStatus, HarnessEvent } from './types.ts';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  containerId: string,
  cmd: string[],
  env: Record<string, string>,
  stdin: string,
  signal?: AbortSignal
) => Promise<ExecResult>;

/**
 * Full tool auto-approval. The container + branch + tests are the safety net, so
 * the agent runs every tool without per-call permission prompts — the run is
 * fully autonomous.
 */
const AUTO_APPROVE_FLAG = '--auto-approve';

/**
 * Instruct-only git boundary (v1): the engine owns all git operations and the
 * agent only edits files. Passed as a system-prompt instruction; enforcement is
 * by instruction for now (the engine still drives every commit itself).
 */
export const ENGINE_OWNS_GIT_INSTRUCTION =
  'The orchestration engine owns all git operations — branching, staging, committing, and ' +
  'worktrees. Do NOT run any git commands. Only create and edit files; the engine commits ' +
  'your changes itself after its checks pass.';

function toFinalStatus(s: unknown): FinalStatus {
  if (s === 'passed' || s === 'verify_failed' || s === 'harness_error') return s;
  return 'harness_error';
}

function normalizePiEvent(raw: unknown): HarnessEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as Record<string, unknown>;

  switch (ev.type) {
    case 'task_started':
      return { type: 'task_started' };
    case 'tool_use':
      return { type: 'tool_use', tool: String(ev.tool ?? ''), input: ev.input };
    case 'activity':
      return { type: 'activity', text: String(ev.text ?? '') };
    case 'final_result':
      return {
        type: 'final_result',
        status: toFinalStatus(ev.status),
        summary: String(ev.summary ?? ''),
      };
    default:
      return null;
  }
}

export function parseEventStream(ndjson: string): {
  events: HarnessEvent[];
  result: FinalResult;
} {
  const events: HarnessEvent[] = [];
  let result: FinalResult | null = null;

  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines
    }

    const ev = normalizePiEvent(parsed);
    if (!ev) continue;
    events.push(ev);

    if (ev.type === 'final_result') {
      result = { status: ev.status, summary: ev.summary };
    }
  }

  return {
    events,
    result: result ?? { status: 'harness_error', summary: 'No final_result event in stream' },
  };
}

export async function runPiHarness(
  containerId: string,
  prompt: string,
  apiKey: string,
  execFn: ExecFn,
  signal?: AbortSignal
): Promise<FinalResult> {
  let execResult: ExecResult;
  try {
    execResult = await execFn(
      containerId,
      ['pi', '--mode', 'json', AUTO_APPROVE_FLAG, '--append-system-prompt', ENGINE_OWNS_GIT_INSTRUCTION],
      // Auth injected at exec time only — never baked into the image or committed.
      { PI_API_KEY: apiKey },
      prompt,
      signal
    );
  } catch (err) {
    return { status: 'harness_error', summary: `exec error: ${err}` };
  }

  if (execResult.exitCode !== 0 && !execResult.stdout.trim()) {
    return {
      status: 'harness_error',
      summary: `pi exited ${execResult.exitCode}: ${execResult.stderr}`,
    };
  }

  const { result } = parseEventStream(execResult.stdout);
  return result;
}
