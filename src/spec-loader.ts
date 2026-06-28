import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { createHash } from 'crypto';
import type { TaskSpec, SubtaskSpec } from './types.ts';

export class SpecLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecLoadError';
  }
}

function contentHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function loadTaskSpec(taskDir: string): TaskSpec {
  const readmePath = join(taskDir, 'README.md');
  let readmeRaw: string;
  try {
    readmeRaw = readFileSync(readmePath, 'utf-8');
  } catch {
    throw new SpecLoadError(`Cannot read ${readmePath}`);
  }

  const { data } = matter(readmeRaw);

  if (!data.slug || typeof data.slug !== 'string') {
    throw new SpecLoadError(`${readmePath}: missing or invalid 'slug' in frontmatter`);
  }
  if (!data.branch || typeof data.branch !== 'string') {
    throw new SpecLoadError(`${readmePath}: missing or invalid 'branch' in frontmatter`);
  }

  let files: string[];
  try {
    files = readdirSync(taskDir)
      .filter(f => /^\d{2}-.*\.md$/.test(f))
      .sort();
  } catch {
    throw new SpecLoadError(`Cannot read directory ${taskDir}`);
  }

  const subtasks: SubtaskSpec[] = [];
  const slugsSeen = new Set<string>();

  for (const file of files) {
    const filePath = join(taskDir, file);
    const raw = readFileSync(filePath, 'utf-8');
    const { data: fm, content: body } = matter(raw);

    if (!fm.slug || typeof fm.slug !== 'string') {
      throw new SpecLoadError(`${filePath}: missing or invalid 'slug' in frontmatter`);
    }
    if (!fm.verify || typeof fm.verify !== 'string') {
      throw new SpecLoadError(`${filePath}: missing or invalid 'verify' in frontmatter`);
    }
    if (slugsSeen.has(fm.slug)) {
      throw new SpecLoadError(`${filePath}: duplicate slug '${fm.slug}'`);
    }
    slugsSeen.add(fm.slug);

    const blockedBy: string[] = Array.isArray(fm.blockedBy) ? fm.blockedBy : [];

    subtasks.push({
      slug: fm.slug,
      verify: fm.verify,
      hitl: !!fm.hitl,
      blockedBy,
      body: body.trim(),
      contentHash: contentHash(raw),
      filePath,
    });
  }

  // Validate blockedBy references resolve to sibling slugs
  for (const st of subtasks) {
    for (const dep of st.blockedBy) {
      if (!slugsSeen.has(dep)) {
        throw new SpecLoadError(
          `Subtask '${st.slug}': blockedBy references unknown slug '${dep}'`
        );
      }
    }
  }

  return {
    slug: data.slug,
    branch: data.branch,
    image: typeof data.image === 'string' ? data.image : undefined,
    subtasks,
    dir: taskDir,
  };
}
