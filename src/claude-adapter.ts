import type { FinalResult, FinalStatus, HarnessEvent } from './types.ts';
import {
  ENGINE_OWNS_GIT_INSTRUCTION,
  makeStreamConsumer,
  parseStream,
} from './harness-adapter.ts';
import type { EventNormalizer, ExecResult, HarnessRunner } from './harness-adapter.ts';

/**
 * Full permission auto-approval inside the sandbox — Claude's equivalent of pi's
 * `--auto-approve`. The container + branch + verify are the safety net, so the
 * agent runs every tool non-interactively with no per-call permission prompt.
 */
const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * Maps a Claude `result` event to the common terminal taxonomy. Claude never
 * runs our verify itself, so a cleanly completed turn is `passed` — the engine's
 * own verify is then authoritative over real pass/fail. Any error subtype
 * (`error_max_turns`, `error_during_execution`, …) or an `is_error` flag is a
 * harness failure that short-circuits the attempt.
 */
function claudeResultStatus(ev: Record<string, unknown>): FinalStatus {
  if (ev.is_error === true) return 'harness_error';
  if (ev.subtype === 'success') return 'passed';
  return 'harness_error';
}

/**
 * Normalizes one line of `claude -p --output-format stream-json` into the common
 * contract. Claude's stream is richer than pi's, so several event shapes have no
 * contract equivalent and are dropped without breaking the contract:
 *
 * - `system`/`init`      → `task_started` (other system subtypes ignored)
 * - `assistant` message  → an `activity` per text block + a `tool_use` per
 *                          tool_use block (a turn may carry several of each)
 * - `result`             → `final_result` with the mapped terminal status
 * - `user` (tool results), partial `stream_event` deltas, …  → ignored
 */
export const normalizeClaudeEvents: EventNormalizer = raw => {
  if (!raw || typeof raw !== 'object') return [];
  const ev = raw as Record<string, unknown>;

  switch (ev.type) {
    case 'system':
      return ev.subtype === 'init' ? [{ type: 'task_started' }] : [];

    case 'assistant': {
      const msg = ev.message as { content?: unknown } | undefined;
      const content = Array.isArray(msg?.content) ? msg!.content : [];
      const out: HarnessEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          const text = b.text.trim();
          if (text) out.push({ type: 'activity', text });
        } else if (b.type === 'tool_use') {
          out.push({ type: 'tool_use', tool: String(b.name ?? ''), input: b.input });
        }
      }
      return out;
    }

    case 'result':
      return [
        {
          type: 'final_result',
          status: claudeResultStatus(ev),
          summary: String(ev.result ?? ev.subtype ?? ''),
        },
      ];

    default:
      return [];
  }
};

export function parseClaudeEventStream(ndjson: string): {
  events: HarnessEvent[];
  result: FinalResult;
} {
  return parseStream(ndjson, normalizeClaudeEvents);
}

export const runClaudeHarness: HarnessRunner = async (
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
      // `-p` is non-interactive print mode; stream-json requires `--verbose`.
      // The prompt arrives on stdin (same as pi), keeping the exec seam uniform.
      [
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        SKIP_PERMISSIONS_FLAG,
        '--append-system-prompt',
        ENGINE_OWNS_GIT_INSTRUCTION,
      ],
      // Auth injected at exec time only — never baked into the image or committed.
      { ANTHROPIC_API_KEY: apiKey },
      prompt,
      signal,
      onEvent ? makeStreamConsumer(normalizeClaudeEvents, onEvent) : undefined
    );
  } catch (err) {
    return { status: 'harness_error', summary: `exec error: ${err}` };
  }

  if (execResult.exitCode !== 0 && !execResult.stdout.trim()) {
    return {
      status: 'harness_error',
      summary: `claude exited ${execResult.exitCode}: ${execResult.stderr}`,
    };
  }

  const { result } = parseClaudeEventStream(execResult.stdout);
  return result;
};
