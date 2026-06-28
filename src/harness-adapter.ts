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
  signal?: AbortSignal,
  /**
   * Called with each chunk of stdout as it arrives, so the caller can react to
   * the harness event stream live (e.g. the engine writing throttled activity)
   * instead of only after the process exits.
   */
  onStdout?: (chunk: string) => void
) => Promise<ExecResult>;

/**
 * A harness adapter: spawn the agent in a container, normalize its event stream
 * to the common contract, and return the single terminal {@link FinalResult}.
 * The pi and Claude adapters implement this exact signature, so selecting a
 * harness is nothing more than choosing a runner — the engine, scheduler,
 * verify, and git layers never learn which agent ran.
 */
export type HarnessRunner = (
  containerId: string,
  prompt: string,
  apiKey: string,
  execFn: ExecFn,
  signal?: AbortSignal,
  /** Live per-event hook fired as the stream arrives (drives the activity line). */
  onEvent?: (ev: HarnessEvent) => void
) => Promise<FinalResult>;

/**
 * Maps one raw stream object into zero or more normalized contract events. Each
 * harness differs only in this function; the NDJSON splitting, buffering, and
 * terminal-result tracking below are shared so every adapter normalizes to the
 * identical {@link HarnessEvent} contract.
 */
export type EventNormalizer = (raw: unknown) => HarnessEvent[];

/**
 * Full tool auto-approval. The container + branch + tests are the safety net, so
 * the agent runs every tool without per-call permission prompts — the run is
 * fully autonomous.
 */
const AUTO_APPROVE_FLAG = '--auto-approve';

/**
 * Instruct-only git boundary (v1): the engine owns all git operations and the
 * agent only edits files. Passed as a system-prompt instruction; enforcement is
 * by instruction for now (the engine still drives every commit itself). Shared
 * verbatim across harnesses so the git boundary is identical regardless of agent.
 */
export const ENGINE_OWNS_GIT_INSTRUCTION =
  'The orchestration engine owns all git operations — branching, staging, committing, and ' +
  'worktrees. Do NOT run any git commands. Only create and edit files; the engine commits ' +
  'your changes itself after its checks pass.';

export function toFinalStatus(s: unknown): FinalStatus {
  if (s === 'passed' || s === 'verify_failed' || s === 'harness_error') return s;
  return 'harness_error';
}

/**
 * Generic NDJSON → `{ events, result }`. Shared by every adapter; only the
 * per-line {@link EventNormalizer} differs. The last `final_result` wins, and a
 * stream that never produces one is classified as a `harness_error`.
 */
export function parseStream(
  ndjson: string,
  normalize: EventNormalizer
): { events: HarnessEvent[]; result: FinalResult } {
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

    for (const ev of normalize(parsed)) {
      events.push(ev);
      if (ev.type === 'final_result') {
        result = { status: ev.status, summary: ev.summary };
      }
    }
  }

  return {
    events,
    result: result ?? { status: 'harness_error', summary: 'No final_result event in stream' },
  };
}

/**
 * Splits a stdout byte stream into whole NDJSON lines and emits a normalized
 * {@link HarnessEvent} for each. Buffers any trailing partial line across chunks.
 * Generic over the {@link EventNormalizer} so both adapters reuse it.
 */
export function makeStreamConsumer(
  normalize: EventNormalizer,
  onEvent: (ev: HarnessEvent) => void
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      for (const ev of normalize(parsed)) onEvent(ev);
    }
  };
}

// ── pi adapter ────────────────────────────────────────────────────────────────

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

/** pi already emits the common contract verbatim; normalization is a passthrough. */
export const normalizePiEvents: EventNormalizer = raw => {
  const ev = normalizePiEvent(raw);
  return ev ? [ev] : [];
};

export function parseEventStream(ndjson: string): {
  events: HarnessEvent[];
  result: FinalResult;
} {
  return parseStream(ndjson, normalizePiEvents);
}

export const runPiHarness: HarnessRunner = async (
  containerId,
  prompt,
  apiKey,
  execFn,
  signal,
  onEvent
): Promise<FinalResult> => {
  let execResult: ExecResult;
  try {
    execResult = await execFn(
      containerId,
      ['pi', '--mode', 'json', AUTO_APPROVE_FLAG, '--append-system-prompt', ENGINE_OWNS_GIT_INSTRUCTION],
      // Auth injected at exec time only — never baked into the image or committed.
      { PI_API_KEY: apiKey },
      prompt,
      signal,
      onEvent ? makeStreamConsumer(normalizePiEvents, onEvent) : undefined
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
};
