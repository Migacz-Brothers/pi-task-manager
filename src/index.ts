import { join } from 'path';
import { readdirSync, statSync, mkdirSync } from 'fs';
import { loadTaskSpec } from './spec-loader.ts';
import { openDb } from './state-store.ts';
import { runTask } from './engine.ts';

async function main(): Promise<void> {
  const repoPath = process.cwd();
  const specsDir = join(repoPath, '.specs');
  const stateDir = join(specsDir, '.state');

  mkdirSync(stateDir, { recursive: true });

  const db = openDb(join(stateDir, 'engine.db'));

  const apiKey = process.env.PI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    console.error('Error: PI_API_KEY or ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
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

  for (const taskDir of taskDirs) {
    let task;
    try {
      task = loadTaskSpec(taskDir);
    } catch (err) {
      console.error(`Failed to load task at ${taskDir}: ${err}`);
      continue;
    }

    console.log(`Task: ${task.slug}  branch: ${task.branch}`);
    try {
      await runTask(task, { repoPath, apiKey, db });
    } catch (err) {
      console.error(`Task '${task.slug}' failed: ${err}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
