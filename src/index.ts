import { join } from 'path';
import { readdirSync, statSync, mkdirSync } from 'fs';
import { loadTaskSpec } from './spec-loader.ts';
import { openDb } from './infra/db/index.ts';
import { runTask } from './engine.ts';
import { runQueue } from './task-scheduler.ts';
import { reconcile } from './reconciler.ts';
import { resolveApiKey, AuthError } from './infra/auth.ts';
import type { TaskSpec } from './types.ts';

async function main(): Promise<void> {
  const repoPath = process.cwd();
  const specsDir = join(repoPath, '.specs');
  const stateDir = join(specsDir, '.state');

  mkdirSync(stateDir, { recursive: true });

  const db = openDb(join(stateDir, 'engine.db'));

  // Crash recovery: before resuming the queue, reconcile SQLite + containers
  // against reality. Any subtask left `running` by a prior crash is reset to
  // `pending` (re-run), and orphaned task containers are killed. No daemon means
  // this is the only recovery point — it happens on each manual invocation.
  const recovery = await reconcile(db);
  if (recovery.resetSubtasks > 0) {
    console.log(
      `Recovery: reset ${recovery.resetSubtasks} interrupted subtask(s) to pending; re-running.`
    );
  }

  // Fail fast on a missing credential — clearer here than as a confusing agent
  // error mid-run. Sourced from host env or a gitignored secrets file.
  let apiKey: string;
  try {
    apiKey = resolveApiKey(repoPath);
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  let entries: string[];
  try {
    entries = readdirSync(specsDir);
  } catch {
    console.error(`Cannot read specs directory: ${specsDir}`);
    process.exit(1);
  }

  const taskDirs = entries
    .filter(e => e !== '.state')
    .map(e => join(specsDir, e))
    .filter(p => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });

  if (taskDirs.length === 0) {
    console.log('No task directories found in .specs/');
    return;
  }

  // Load every task spec up front; a spec that fails to parse is reported and
  // dropped so it can't stall the queue. `taskDirs` is already in directory order,
  // which the pool preserves as its deterministic queue ordering.
  const tasks: TaskSpec[] = [];
  for (const taskDir of taskDirs) {
    try {
      tasks.push(loadTaskSpec(taskDir));
    } catch (err) {
      console.error(`Failed to load task at ${taskDir}: ${err}`);
    }
  }

  // One-shot run: up to N tasks execute concurrently, each fully isolated; the
  // pool drains the queue and resolves, then the process exits.
  await runQueue(tasks, {
    runTask: task => runTask(task, { repoPath, apiKey, db }),
  });

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
