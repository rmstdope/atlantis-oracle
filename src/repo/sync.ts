import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoConfig } from '../config.js';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
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
 * The local clone of the game repository. The bot owns this directory: syncing
 * does a hard reset to the remote, discarding any local changes.
 */
export class GameRepo {
  readonly dir: string;
  commit = '';
  branch = '';
  lastSyncedAt: Date | undefined;
  variants: string[] = [];
  private syncing: Promise<void> | undefined;

  constructor(
    private readonly cfg: RepoConfig,
    private readonly logger: Logger,
  ) {
    this.dir = path.resolve(cfg.dir);
  }

  /** Clones the repository if needed, otherwise updates it. */
  sync(): Promise<void> {
    // Serialize: a periodic sync must not overlap a running one.
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  /** Starts periodic syncing. Returns a function that stops it. */
  startPeriodicSync(): () => void {
    if (this.cfg.syncIntervalMinutes <= 0) return () => {};
    const timer = setInterval(() => {
      this.sync().catch((err: unknown) => {
        this.logger.warn({ err }, 'Periodic game repo sync failed; keeping current checkout');
      });
    }, this.cfg.syncIntervalMinutes * 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async doSync(): Promise<void> {
    if (!(await exists(path.join(this.dir, '.git')))) {
      this.logger.info({ url: this.cfg.url, dir: this.dir }, 'Cloning game repository');
      const branchArgs = this.cfg.branch ? ['--branch', this.cfg.branch] : [];
      await git(['clone', '--depth', '1', ...branchArgs, this.cfg.url, this.dir]);
    } else {
      const ref = this.cfg.branch ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'], this.dir));
      this.logger.debug({ url: this.cfg.url, ref }, 'Updating game repository');
      await git(['remote', 'set-url', 'origin', this.cfg.url], this.dir);
      await git(['fetch', '--depth', '1', 'origin', ref], this.dir);
      await git(['reset', '--hard', 'FETCH_HEAD'], this.dir);
    }

    const previous = this.commit;
    this.commit = await git(['rev-parse', 'HEAD'], this.dir);
    this.branch = this.cfg.branch ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'], this.dir));
    this.variants = await discoverVariants(this.dir);
    this.lastSyncedAt = new Date();
    if (previous !== this.commit) {
      this.logger.info(
        { commit: this.commit.slice(0, 10), variants: this.variants },
        'Game repository ready',
      );
    }
  }
}

/** Game variants are top-level directories containing a rules.cpp. */
export async function discoverVariants(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const variants: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      if (await exists(path.join(dir, e.name, 'rules.cpp'))) variants.push(e.name);
    }
  }
  return variants.sort();
}
