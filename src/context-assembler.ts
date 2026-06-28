/**
 * The context assembler is a **pure function** (inputs → prompt string) so the
 * retry prompt can be tested in isolation, with no I/O. It folds everything we
 * learned from a failing attempt — the original instructions, the failing verify
 * output, a diff of the partial changes left on disk, and any handoff fragment
 * the agent wrote — into a single fix-forward prompt for the next attempt.
 *
 * It degrades gracefully: an empty diff or an absent fragment never produces a
 * broken prompt, only a noted absence.
 */
export interface RetryContext {
  /** The original subtask instructions; carried verbatim so the agent still has the goal. */
  body: string;
  /** The upcoming attempt number (e.g. 2 for the first retry). */
  attempt: number;
  /** Total attempts allowed before escalation (K). */
  maxAttempts: number;
  /** Combined stdout/stderr of the failing verify command (or the harness error summary). */
  verifyOutput: string;
  /** Diff of the previous attempt's changes still on disk. May be empty. */
  diff: string;
  /** Optional handoff notes the agent wrote to `.orchestrator/handoff.md`. */
  fragment?: string;
  /**
   * Optional note a human attached to a `retry` command. Carries human guidance
   * the automated context (verify output, diff, fragment) can't — surfaced
   * prominently so the next attempt acts on it.
   */
  note?: string;
}

/** Wrap text in a fenced block, picking a fence long enough to not collide with the content. */
function fence(text: string, lang = ''): string {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/**
 * Build the fix-forward retry prompt. The sections are always present and in a
 * stable order so the agent can rely on the shape; missing inputs collapse to an
 * explicit "(none)" note rather than vanishing.
 */
export function assembleRetryPrompt(ctx: RetryContext): string {
  const verify = ctx.verifyOutput.trim();
  const diff = ctx.diff.trim();

  const sections: string[] = [
    ctx.body.trim(),
    `## Retry context (attempt ${ctx.attempt} of ${ctx.maxAttempts})\n` +
      `A previous attempt did not pass. Its partial changes are still on disk — fix forward ` +
      `over them rather than starting from scratch. If you cannot finish, write what you ` +
      `learned to \`.orchestrator/handoff.md\` so the next attempt can pick up.`,
    `### Failing verify output\n` +
      (verify ? fence(verify) : '_(no verify output was captured)_'),
    `### Diff of the previous attempt's changes\n` +
      (diff ? fence(diff, 'diff') : '_(the previous attempt changed nothing on disk)_'),
  ];

  const fragment = ctx.fragment?.trim();
  if (fragment) {
    sections.push(`### Handoff notes from the previous attempt\n${fragment}`);
  }

  const note = ctx.note?.trim();
  if (note) {
    sections.push(`### Note from the human (act on this)\n${note}`);
  }

  return sections.join('\n\n') + '\n';
}
