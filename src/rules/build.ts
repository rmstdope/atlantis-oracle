import { execFile, spawn } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface BuildRequest {
  repoDir: string;
  variants: string[];
  /** Scratch directory owned by the builder; wiped for each build. */
  workDir: string;
  logger: Logger;
}

/** Builds rules HTML for the requested variants; returns variant -> HTML path for successes. */
export type RulesBuilder = (req: BuildRequest) => Promise<Map<string, string>>;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${cmd} ${args.join(' ')} failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds each variant with the game's own Makefile and flags, then runs
 * `<variant> genrules`. Works on a `git archive` export so build artifacts
 * never land in the clone the tools search.
 */
export const makeRulesBuilder: RulesBuilder = async ({ repoDir, variants, workDir, logger }) => {
  const src = path.join(workDir, 'src');
  const out = path.join(workDir, 'out');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(src, { recursive: true });
  await mkdir(out, { recursive: true });

  const { stdout: archive } = await execFileAsync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: repoDir,
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-x', '-C', src], { stdio: ['pipe', 'ignore', 'pipe'] });
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    tar.stdin.end(archive);
  });

  if (!(await exists(path.join(src, 'Makefile')))) {
    throw new Error('The game repository has no Makefile');
  }

  const built = new Map<string, string>();
  const jobs = String(Math.max(1, availableParallelism()));
  for (const variant of variants) {
    const started = Date.now();
    try {
      const intro = path.join(variant, `${variant}_intro.html`);
      if (!(await exists(path.join(src, intro)))) throw new Error(`missing ${intro}`);
      await run('make', ['-j', jobs, `GAME=${variant}`], src, 15 * 60_000);
      const html = path.join(out, `${variant}.html`);
      await run(
        path.join(src, variant, variant),
        ['genrules', intro, `${variant}.css`, html],
        src,
        60_000,
      );
      built.set(variant, html);
      logger.info({ variant, ms: Date.now() - started }, 'Built rules');
    } catch (err) {
      logger.warn({ variant, err: err instanceof Error ? err.message : err }, 'Rules build failed');
    }
  }
  return built;
};
