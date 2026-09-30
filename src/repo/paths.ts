import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Thrown for paths the LLM may not access. The message is shown to the model. */
export class PathError extends Error {}

/**
 * Resolves a repo-relative path to an absolute path inside `root`.
 * Rejects absolute paths, `..` escapes, `.git` and symlinks that resolve outside the repo.
 * The target must exist.
 */
export async function resolveInRepo(root: string, rel: string): Promise<string> {
  const cleaned = rel.trim().replace(/\\/g, '/');
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new PathError(`Path must be relative to the repository root: ${rel}`);
  }
  const normalized = path.posix.normalize(cleaned === '' ? '.' : cleaned);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new PathError(`Path is outside the repository: ${rel}`);
  }
  if (normalized.split('/').includes('.git')) {
    throw new PathError(`Access to .git is not allowed: ${rel}`);
  }

  const rootReal = await realpath(root);
  let targetReal: string;
  try {
    targetReal = await realpath(path.join(rootReal, normalized));
  } catch {
    throw new PathError(`No such file or directory: ${normalized}`);
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new PathError(`Path is outside the repository: ${rel}`);
  }
  return targetReal;
}

/** Repo-relative POSIX path for display, e.g. in citations. */
export function toRepoRelative(rootReal: string, absolute: string): string {
  return path.relative(rootReal, absolute).split(path.sep).join('/') || '.';
}
