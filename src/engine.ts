import type { Database } from 'bun:sqlite';
import type { TaskSpec } from './types.ts';
import {
  upsertTask,
  upsertSubtask,
  setSubtaskStatus,
  incrementAttempts,
} from './state-store.ts';
import { runPiHarness } from './harness-adapter.ts';
import {
  startContainer,
  execInContainer,
  stopContainer,
} from './container-manager.ts';
import { ensureBranch, commitAll } from './git-manager.ts';

const DEFAULT_IMAGE = 'ubuntu:22.04';

export interface EngineOptions {
  repoPath: string;
  apiKey: string;
  db: Database;
}

export async function runTask(task: TaskSpec, opts: EngineOptions): Promise<void> {
  const { repoPath, apiKey, db } = opts;

  const taskId = upsertTask(db, task.slug, task.branch);
  for (const subtask of task.subtasks) {
    upsertSubtask(db, taskId, subtask.slug, subtask.verify, subtask.contentHash);
  }

  await ensureBranch(repoPath, task.branch);

  const image = task.image ?? DEFAULT_IMAGE;
  const containerLabel = `pi-task-manager.task=${task.slug}`;

  let containerId: string;
  try {
    containerId = await startContainer(image, repoPath, containerLabel, { PI_API_KEY: apiKey });
  } catch (err) {
    throw new Error(`Container failed to start for task '${task.slug}': ${err}`);
  }

  try {
    for (const subtask of task.subtasks) {
      const row = db
        .query('SELECT id FROM subtasks WHERE task_id = ? AND slug = ?')
        .get(taskId, subtask.slug) as { id: number };
      const subtaskId = row.id;

      setSubtaskStatus(db, subtaskId, 'running');
      incrementAttempts(db, subtaskId);

      const finalResult = await runPiHarness(
        containerId,
        subtask.body,
        apiKey,
        (cid, cmd, env, stdin) => execInContainer(cid, cmd, env, stdin)
      );

      if (finalResult.status !== 'passed') {
        setSubtaskStatus(db, subtaskId, finalResult.status);
        console.log(`  [${subtask.slug}] ${finalResult.status}: ${finalResult.summary}`);
        continue;
      }

      // Verify inside the container
      const verifyResult = await execInContainer(containerId, ['sh', '-c', subtask.verify]);

      if (verifyResult.exitCode !== 0) {
        setSubtaskStatus(db, subtaskId, 'verify_failed');
        console.log(`  [${subtask.slug}] verify_failed`);
        if (verifyResult.stdout) console.log(verifyResult.stdout);
        if (verifyResult.stderr) console.log(verifyResult.stderr);
        continue;
      }

      await commitAll(repoPath, `${task.slug}(${subtask.slug}): passed`);
      setSubtaskStatus(db, subtaskId, 'passed');
      console.log(`  [${subtask.slug}] passed`);
    }
  } finally {
    await stopContainer(containerId);
  }
}
