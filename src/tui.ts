/**
 * pi-tui — the task monitor.
 *
 * A thin client over the engine's SQLite state: a pure *reader* of execution
 * state for display and a *writer* only of the `commands` bus for control. It
 * never writes execution state. Closing it does not stop the engine.
 *
 * Layout (mirrors the tool-tester TUI and the pi-tui primitives):
 *   ┌ header ─────────────────────────────────────────────┐
 *   │ task/subtask tree (left)  │  detail for selection (right)
 *   └ action bar ─────────────────────────────────────────┘
 *
 * The tree shows status glyphs, X/Y progress, the attempt counter, and a spinner
 * on the running subtask. The detail pane shows the live activity, verify output,
 * failure fragment, or hitl instructions for the selected node. The action bar
 * writes reason-specific commands (retry/approve/skip/abort + optional note).
 */
import { join } from 'path';
import { existsSync } from 'fs';
import {
  TUI,
  Container,
  Text,
  Markdown,
  Input,
  ProcessTerminal,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type MarkdownTheme,
} from '@earendil-works/pi-tui';
import {
  openDb,
  TaskRepository,
  SubtaskRepository,
  EventRepository,
  CommandRepository,
} from './infra/db/index.ts';
import type { EventRow } from './infra/db/index.ts';
import type { CommandAction, SubtaskStatus } from './types.ts';

// ── ANSI styling ────────────────────────────────────────────────────────────
// pi-tui's width helpers are ANSI-aware, so styled strings truncate/pad cleanly.
const ESC = '\x1b[';
const sgr = (code: string, s: string): string => `${ESC}${code}m${s}${ESC}0m`;
const c = {
  bold: (s: string) => sgr('1', s),
  dim: (s: string) => sgr('2', s),
  red: (s: string) => sgr('31', s),
  green: (s: string) => sgr('32', s),
  yellow: (s: string) => sgr('33', s),
  blue: (s: string) => sgr('34', s),
  magenta: (s: string) => sgr('35', s),
  cyan: (s: string) => sgr('36', s),
  gray: (s: string) => sgr('90', s),
  inverse: (s: string) => sgr('7', s),
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** K — the engine's retry limit; shown in the attempt counter (e.g. `1/2`). */
const MAX_ATTEMPTS = 2;

const mdTheme: MarkdownTheme = {
  heading: c.bold,
  link: c.cyan,
  linkUrl: c.dim,
  code: c.yellow,
  codeBlock: c.yellow,
  codeBlockBorder: c.gray,
  quote: c.dim,
  quoteBorder: c.gray,
  hr: c.gray,
  listBullet: c.cyan,
  bold: c.bold,
  italic: c.dim,
  strikethrough: s => s,
  underline: s => s,
};

// ── Read model ──────────────────────────────────────────────────────────────
interface SubtaskNode {
  slug: string;
  status: SubtaskStatus;
  attempts: number;
  activity: string | null;
  phase: string | null;
  verify: string;
}
interface TaskNode {
  slug: string;
  branch: string;
  status: string;
  subtasks: SubtaskNode[];
  events: EventRow[];
}
type FlatRow =
  | { kind: 'task'; task: TaskNode }
  | { kind: 'subtask'; task: TaskNode; subtask: SubtaskNode };

function readModel(db: ReturnType<typeof openDb>): TaskNode[] {
  const tasks = new TaskRepository(db);
  const subtasks = new SubtaskRepository(db);
  const events = new EventRepository(db);
  return tasks.list().map(t => ({
    slug: t.slug,
    branch: t.branch,
    status: t.status,
    subtasks: subtasks.listByTask(t.id).map(s => ({
      slug: s.slug,
      status: s.status,
      attempts: s.attempts,
      activity: s.current_activity,
      phase: s.current_phase,
      verify: s.verify,
    })),
    events: events.list(t.slug),
  }));
}

function flatten(model: TaskNode[]): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const task of model) {
    rows.push({ kind: 'task', task });
    for (const subtask of task.subtasks) rows.push({ kind: 'subtask', task, subtask });
  }
  return rows;
}

const rowKey = (r: FlatRow): string =>
  r.kind === 'task' ? `t:${r.task.slug}` : `s:${r.task.slug}/${r.subtask.slug}`;

// ── Status presentation ───────────────────────────────────────────────────
function glyph(status: SubtaskStatus): { ch: string; color: (s: string) => string } {
  switch (status) {
    case 'pending': return { ch: '○', color: c.gray };
    case 'running': return { ch: '⟳', color: c.cyan };
    case 'passed': return { ch: '✓', color: c.green };
    case 'verify_failed':
    case 'harness_error': return { ch: '✗', color: c.red };
    case 'blocked': return { ch: '⊘', color: c.gray };
    case 'needs_human': return { ch: '⚠', color: c.yellow };
    case 'skipped': return { ch: '⊝', color: c.gray };
    default: return { ch: '?', color: c.gray };
  }
}

/**
 * Why a subtask is paused, read from its event history: an author-marked `hitl`
 * pause accepts approve/skip/abort; a failure pause accepts retry/skip/abort.
 */
function pauseReason(task: TaskNode, subSlug: string): 'hitl' | 'failure' | null {
  let reason: 'hitl' | 'failure' | null = null;
  for (const e of task.events) {
    if (e.subtask_slug !== subSlug) continue;
    if (e.type === 'needs_human:hitl') reason = 'hitl';
    else if (e.type === 'needs_human:failure') reason = 'failure';
  }
  return reason;
}

function latestEvent(task: TaskNode, subSlug: string, type: string): EventRow | null {
  let found: EventRow | null = null;
  for (const e of task.events) {
    if (e.subtask_slug === subSlug && e.type === type) found = e;
  }
  return found;
}

function latestAttemptFailure(task: TaskNode, subSlug: string): string | null {
  let detail: string | null = null;
  for (const e of task.events) {
    if (e.subtask_slug === subSlug && e.type.startsWith('attempt_failed:')) {
      detail = e.detail;
    }
  }
  return detail;
}

// ── Width helpers ───────────────────────────────────────────────────────────
function padTo(s: string, w: number): string {
  const vis = visibleWidth(s);
  if (vis > w) return truncateToWidth(s, w);
  return s + ' '.repeat(Math.max(0, w - vis));
}

function blankLines(n: number, w: number): string[] {
  return Array.from({ length: Math.max(0, n) }, () => ' '.repeat(w));
}

// ── Note overlay ──────────────────────────────────────────────────────────
/**
 * A small modal asking for an optional free-text note before a retry/approve.
 * Enter sends (empty allowed → no note); Esc cancels.
 */
class NotePrompt extends Container implements Focusable {
  private readonly input = new Input();
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.input.focused = v;
  }
  constructor(title: string, onDone: (note: string | null) => void) {
    super();
    this.addChild(new Text(c.bold(title), 1, 0));
    this.addChild(new Text(c.dim('Enter to send · Esc to cancel'), 1, 0));
    this.addChild(this.input);
    this.input.onSubmit = v => onDone(v);
    this.input.onEscape = () => onDone(null);
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

// ── The app ─────────────────────────────────────────────────────────────────
export class App implements Component {
  private model: TaskNode[] = [];
  private selectedKey: string | null = null;
  private scrollTop = 0;
  private spinnerFrame = 0;
  private overlayOpen = false;

  constructor(
    private readonly tui: TUI,
    private readonly db: ReturnType<typeof openDb>
  ) {
    this.reload();
  }

  /** Re-read state from SQLite (the ~250ms poll). The engine is the writer. */
  reload(): void {
    this.model = readModel(this.db);
    const rows = flatten(this.model);
    if (rows.length === 0) {
      this.selectedKey = null;
      return;
    }
    if (!this.selectedKey || !rows.some(r => rowKey(r) === this.selectedKey)) {
      this.selectedKey = rowKey(rows[0]!);
    }
  }

  /** Advance the spinner; called on each poll tick so it animates. */
  tick(): void {
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
  }

  private selectedRow(): FlatRow | null {
    const rows = flatten(this.model);
    return rows.find(r => rowKey(r) === this.selectedKey) ?? rows[0] ?? null;
  }

  private move(delta: number): void {
    const rows = flatten(this.model);
    if (rows.length === 0) return;
    let idx = rows.findIndex(r => rowKey(r) === this.selectedKey);
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
    this.selectedKey = rowKey(rows[idx]!);
  }

  // --- input ---------------------------------------------------------------
  handleInput(data: string): void {
    if (this.overlayOpen) return; // the overlay owns input while open
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.move(-1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.move(1);
    } else if (matchesKey(data, 'q') || matchesKey(data, Key.ctrl('c'))) {
      quit(this.tui);
      return;
    } else {
      this.handleAction(data);
    }
    this.tui.requestRender();
  }

  private handleAction(data: string): void {
    const row = this.selectedRow();
    if (!row || row.kind !== 'subtask') return;
    if (row.subtask.status !== 'needs_human') return;
    const reason = pauseReason(row.task, row.subtask.slug);
    const taskSlug = row.task.slug;
    const subSlug = row.subtask.slug;

    if (matchesKey(data, 's')) {
      this.send('skip', taskSlug, subSlug);
    } else if (matchesKey(data, 'x')) {
      this.send('abort', taskSlug, subSlug);
    } else if (reason === 'hitl' && matchesKey(data, 'a')) {
      this.openNote('approve', taskSlug, subSlug);
    } else if (reason === 'failure' && matchesKey(data, 'r')) {
      this.openNote('retry', taskSlug, subSlug);
    }
  }

  /** Write a command row to the bus; the engine consumes it on its next poll. */
  private send(action: CommandAction, taskSlug: string, subSlug: string, note?: string): void {
    new CommandRepository(this.db).enqueue(taskSlug, subSlug, action, note);
    this.tui.requestRender();
  }

  private openNote(action: CommandAction, taskSlug: string, subSlug: string): void {
    this.overlayOpen = true;
    let handle: { hide(): void } | null = null;
    const prompt = new NotePrompt(`${action} ${subSlug} — optional note`, note => {
      handle?.hide();
      this.overlayOpen = false;
      this.tui.setFocus(this);
      if (note !== null) this.send(action, taskSlug, subSlug, note.trim() || undefined);
      this.tui.requestRender();
    });
    handle = this.tui.showOverlay(prompt, { width: '60%', anchor: 'center', minWidth: 30 });
    this.tui.requestRender();
  }

  // --- render --------------------------------------------------------------
  invalidate(): void {}

  render(width: number): string[] {
    const rows = Math.max(6, this.tui.terminal.rows || 24);
    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyHeight = Math.max(1, rows - header.length - footer.length);
    const body = this.renderBody(width, bodyHeight);
    return [...header, ...body, ...footer].map(l => truncateToWidth(l, width));
  }

  private renderHeader(width: number): string[] {
    const total = this.model.reduce((n, t) => n + t.subtasks.length, 0);
    const passed = this.model.reduce(
      (n, t) => n + t.subtasks.filter(s => s.status === 'passed').length,
      0
    );
    const running = this.model.some(t => t.subtasks.some(s => s.status === 'running'));
    const paused = this.model.reduce(
      (n, t) => n + t.subtasks.filter(s => s.status === 'needs_human').length,
      0
    );
    const left = c.bold(' pi-tui ') + c.dim('· task monitor');
    const parts = [`${passed}/${total} passed`];
    if (running) parts.push(c.cyan('running'));
    if (paused > 0) parts.push(c.yellow(`${paused} need human`));
    const right = c.dim(parts.join('  ') + ' ');
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [padTo(left + ' '.repeat(gap) + right, width)];
  }

  private renderBody(width: number, height: number): string[] {
    if (flatten(this.model).length === 0) {
      const msg = [
        '',
        c.dim('  No tasks yet.'),
        c.dim('  Start the engine:  bun run src/index.ts'),
      ];
      return [...msg, ...blankLines(height - msg.length, width)].slice(0, height);
    }

    // Narrow terminals: drop the detail pane and give the tree the full width so
    // rows truncate responsively instead of wrapping into garbage.
    if (width < 60) {
      return this.renderTree(width, height);
    }

    const leftWidth = Math.max(22, Math.min(60, Math.round(width * 0.42)));
    const sep = c.gray(' │ ');
    const rightWidth = Math.max(1, width - leftWidth - 3);
    const tree = this.renderTree(leftWidth, height);
    const detail = this.renderDetail(rightWidth, height);
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      out.push(padTo(tree[i] ?? '', leftWidth) + sep + padTo(detail[i] ?? '', rightWidth));
    }
    return out;
  }

  private renderTree(width: number, height: number): string[] {
    const rows = flatten(this.model);
    const selectedIdx = Math.max(
      0,
      rows.findIndex(r => rowKey(r) === this.selectedKey)
    );

    // Keep the selection inside the viewport.
    if (selectedIdx < this.scrollTop) this.scrollTop = selectedIdx;
    if (selectedIdx >= this.scrollTop + height) this.scrollTop = selectedIdx - height + 1;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - height)));

    const lines: string[] = [];
    for (let i = this.scrollTop; i < Math.min(rows.length, this.scrollTop + height); i++) {
      const row = rows[i]!;
      const selected = i === selectedIdx;
      lines.push(padTo(this.treeLine(row, selected, width), width));
    }
    return [...lines, ...blankLines(height - lines.length, width)].slice(0, height);
  }

  private treeLine(row: FlatRow, selected: boolean, _width: number): string {
    // The cursor marker is the selection indicator: a whole-line inverse breaks
    // against the per-segment SGR resets in the styled content, so a bright `›`
    // (vs a leading space) reads cleanly without nesting escape codes.
    const cursor = selected ? c.bold(c.cyan('›')) : ' ';
    let body: string;
    if (row.kind === 'task') {
      const t = row.task;
      const done = t.subtasks.filter(s => s.status === 'passed').length;
      const progress = c.dim(`${done}/${t.subtasks.length}`);
      const status = t.status !== 'pending' ? c.dim(` [${t.status}]`) : '';
      body = `${c.bold('▸ ' + t.slug)}  ${progress}${status}`;
    } else {
      const s = row.subtask;
      const g = glyph(s.status);
      const mark =
        s.status === 'running' ? c.cyan(SPINNER[this.spinnerFrame]!) : g.color(g.ch);
      const attempt =
        s.attempts > 0 && (s.status === 'running' || s.status === 'verify_failed' || s.status === 'harness_error')
          ? c.dim(` ${s.attempts}/${MAX_ATTEMPTS}`)
          : '';
      body = `  ${mark} ${g.color(s.slug)}${attempt}`;
    }
    return `${cursor} ${body}`;
  }

  private renderDetail(width: number, height: number): string[] {
    const row = this.selectedRow();
    if (!row) return blankLines(height, width);
    this.detailWidth = width; // markdown / wrap helpers read this for column count
    const lines = row.kind === 'task' ? this.taskDetail(row.task) : this.subtaskDetail(row);
    return [...lines, ...blankLines(height - lines.length, width)].slice(0, height).map(l => padTo(l, width));
  }

  private taskDetail(t: TaskNode): string[] {
    const counts: Record<string, number> = {};
    for (const s of t.subtasks) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const summary = Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    return [
      c.bold(`Task: ${t.slug}`),
      c.dim(`branch: ${t.branch}`),
      c.dim(`status: ${t.status}`),
      '',
      c.dim('subtasks: ') + (summary || 'none'),
    ];
  }

  private subtaskDetail(row: Extract<FlatRow, { kind: 'subtask' }>): string[] {
    const { task, subtask: s } = row;
    const g = glyph(s.status);
    const out: string[] = [
      `${g.color(g.ch)} ${c.bold(s.slug)}  ${g.color(s.status)}`,
      c.dim(`verify: ${s.verify}`),
    ];
    if (s.attempts > 0) out.push(c.dim(`attempts: ${s.attempts}/${MAX_ATTEMPTS}`));
    out.push('');

    if (s.status === 'running') {
      out.push(c.cyan(`${SPINNER[this.spinnerFrame]!} live activity`));
      out.push(...this.wrapBlock(s.activity ?? '…working…', this.detailWidth));
      if (s.phase) out.push('', c.dim(`phase: ${s.phase}`));
      return out;
    }

    if (s.status === 'needs_human') {
      const reason = pauseReason(task, s.slug);
      if (reason === 'hitl') {
        const ev = latestEvent(task, s.slug, 'needs_human:hitl');
        out.push(c.yellow('⚠ Human action required (hitl)'), '');
        out.push(...this.markdown(ev?.detail ?? '(no instructions authored)'));
        return out;
      }
      out.push(c.yellow('⚠ Escalated to human after retries'), '');
      const fail = latestAttemptFailure(task, s.slug);
      if (fail) {
        out.push(c.dim('verify output:'));
        out.push(...this.wrapBlock(fail, this.detailWidth));
      }
      const frag = latestEvent(task, s.slug, 'fragment');
      if (frag?.detail) {
        out.push('', c.dim('agent handoff fragment:'));
        out.push(...this.markdown(frag.detail));
      }
      return out;
    }

    if (s.status === 'verify_failed' || s.status === 'harness_error') {
      const fail = latestAttemptFailure(task, s.slug);
      out.push(c.red('verify output:'));
      out.push(...this.wrapBlock(fail ?? '(no output captured)', this.detailWidth));
      return out;
    }

    const note: Record<string, string> = {
      passed: '✓ Passed — committed on the task branch.',
      blocked: '⊘ Blocked — a dependency did not pass.',
      skipped: '⊝ Skipped — does not satisfy dependents.',
      pending: '○ Pending — waiting to run.',
    };
    out.push(c.dim(note[s.status] ?? s.status));
    return out;
  }

  // The detail pane re-renders with a known width via padTo; we cache the last
  // width seen so wrapping uses the real column count.
  private detailWidth = 60;
  private wrapBlock(text: string, width: number): string[] {
    return wrapTextWithAnsi(text, Math.max(10, width)).map(l => c.gray(l));
  }
  private markdown(text: string): string[] {
    return new Markdown(text, 0, 0, mdTheme).render(Math.max(10, this.detailWidth));
  }

  private renderFooter(width: number): string[] {
    const row = this.selectedRow();
    let actions = c.dim('—');
    if (row?.kind === 'subtask' && row.subtask.status === 'needs_human') {
      const reason = pauseReason(row.task, row.subtask.slug);
      actions =
        reason === 'hitl'
          ? `${c.green('[a]')}pprove  ${c.yellow('[s]')}kip  ${c.red('[x]')}abort`
          : `${c.cyan('[r]')}etry  ${c.yellow('[s]')}kip  ${c.red('[x]')}abort`;
    }
    const hints = c.dim('[↑/↓] navigate   [q]uit');
    const bar = ` ${actions}`;
    const gap = Math.max(1, width - visibleWidth(bar) - visibleWidth(hints) - 1);
    return [c.gray('─'.repeat(width)), padTo(bar + ' '.repeat(gap) + hints + ' ', width)];
  }
}

function quit(tui: TUI): void {
  tui.stop();
  process.exit(0);
}

function main(): void {
  const dbPath = process.argv[2] ?? join(process.cwd(), '.specs', '.state', 'engine.db');
  if (!existsSync(dbPath)) {
    console.error(
      `No engine database at ${dbPath}.\n` +
        `Start the engine first (bun run src/index.ts), or pass the db path as an argument.`
    );
  }
  const db = openDb(dbPath);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const app = new App(tui, db);
  tui.addChild(app);
  tui.setFocus(app);

  // Ctrl+C in raw mode does not raise SIGINT — intercept it for a clean exit.
  tui.addInputListener(data => {
    if (matchesKey(data, Key.ctrl('c'))) {
      quit(tui);
      return { consume: true };
    }
    return undefined;
  });

  tui.start();

  // Poll SQLite on a timer — the TUI never writes execution state, it just
  // re-reads and re-renders. Closing the TUI (quit) leaves the engine running.
  const timer = setInterval(() => {
    app.reload();
    app.tick();
    tui.requestRender();
  }, 250);
  timer.unref?.();
}

// Only launch the terminal when run as the entry point; importing the module
// (e.g. from a test) gets `App` without starting a TUI.
if (import.meta.main) main();
