import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * A gitignored secrets file (see `.gitignore`) holding `KEY=value` lines. Lets a
 * developer keep the API key out of their shell env without ever committing it.
 */
export const SECRETS_FILE = '.secrets.env';

/** The env var names accepted as the harness token, in precedence order. */
const KEY_NAMES = ['PI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Resolve the harness API key, sourced from the host env first and then a
 * gitignored secrets file in the repo. Fails fast with an actionable
 * {@link AuthError} when neither yields a key — so a missing credential surfaces
 * here, before any container runs, rather than as a confusing agent error
 * mid-run. The key is never baked into an image or committed; the engine injects
 * it at `docker exec` time.
 */
export function resolveApiKey(
  repoPath: string,
  env: Record<string, string | undefined> = process.env
): string {
  for (const name of KEY_NAMES) {
    const v = env[name];
    if (v && v.trim()) return v.trim();
  }

  const secretsPath = join(repoPath, SECRETS_FILE);
  if (existsSync(secretsPath)) {
    const parsed = parseEnvFile(readFileSync(secretsPath, 'utf-8'));
    for (const name of KEY_NAMES) {
      const v = parsed[name];
      if (v && v.trim()) return v.trim();
    }
  }

  throw new AuthError(
    `No API key found. Set PI_API_KEY (or ANTHROPIC_API_KEY) in your environment, ` +
      `or add it to a gitignored ${SECRETS_FILE} at the repo root.`
  );
}
