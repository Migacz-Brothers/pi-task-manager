import type { Database } from 'bun:sqlite';
import type { TaskSpec } from './types.ts';
import { TaskRepository, SubtaskRepository } from './db/index.ts';
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
  const taskRepo = new TaskRepository(db);
  const subtaskRepo = new SubtaskRepository(db);

  const taskId = taskRepo.upsert(task.slug, task.branch);
  for (const subtask of task.subtasks) {
    subtaskRepo.upsert(taskId, subtask.slug, subtask.verify, subtask.contentHash);
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
      const subtaskId = subtaskRepo.findId(taskId, subtask.slug);

      subtaskRepo.setStatus(subtaskId, 'running');
      subtaskRepo.incrementAttempts(subtaskId);

      const finalResult = await runPiHarness(
        containerId,
        subtask.body,
        apiKey,
        (cid, cmd, env, stdin) => execInContainer(cid, cmd, env, stdin)
      );

      if (finalResult.status !== 'passed') {
        subtaskRepo.setStatus(subtaskId, finalResult.status);
        console.log(`  [${subtask.slug}] ${finalResult.status}: ${finalResult.summary}`);
        continue;
      }

      const verifyResult = await execInContainer(containerId, ['sh', '-c', subtask.verify]);

      if (verifyResult.exitCode !== 0) {
        subtaskRepo.setStatus(subtaskId, 'verify_failed');
        console.log(`  [${subtask.slug}] verify_failed`);
        if (verifyResult.stdout) console.log(verifyResult.stdout);
        if (verifyResult.stderr) console.log(verifyResult.stderr);
        continue;
      }

      await commitAll(repoPath, `${task.slug}(${subtask.slug}): passed`);
      subtaskRepo.setStatus(subtaskId, 'passed');
      console.log(`  [${subtask.slug}] passed`);
    }
  } finally {
    await stopContainer(containerId);
  }
}
