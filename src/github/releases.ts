import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { GithubClient, Release } from './client.js';

/** How long /latest-release reuses a lookup. */
const CACHE_MS = 10 * 60_000;
/** First check after start, so a restart notices a release promptly. */
const FIRST_CHECK_MS = 15_000;

const stateSchema = z.object({
  tag: z.string(),
  publishedAt: z.string().nullable(),
});
type ReleaseState = z.infer<typeof stateSchema>;

/** Posts a release announcement; throwing means it is tried again next check. */
export type Announce = (release: Release) => Promise<void>;

/**
 * Knows the latest release: serves /latest-release from a short cache and,
 * when started, announces each new release once. The last announced release
 * is kept in a file, so restarts don't announce it again.
 */
export class ReleaseWatcher {
  private cache: { at: number; release: Release | null } | undefined;
  private checking = false;

  constructor(
    private readonly source: Pick<GithubClient, 'latestRelease'>,
    private readonly statePath: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** The latest release, looked up at most every 10 minutes. */
  async latest(): Promise<Release | null> {
    if (!this.cache || this.now() - this.cache.at > CACHE_MS) await this.refresh();
    return this.cache!.release;
  }

  private async refresh(): Promise<Release | null> {
    const release = await this.source.latestRelease();
    this.cache = { at: this.now(), release };
    return release;
  }

  /**
   * Looks for a release newer than the remembered one and announces it. With
   * nothing remembered yet (the very first run), the current release is
   * announced. A release older than the remembered one (the newest was
   * deleted) is remembered silently.
   */
  async check(announce: Announce): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const release = await this.refresh();
      if (!release) return;
      const known = await this.readState();
      if (known?.tag === release.tag) return;
      if (!known || isNewer(release, known)) {
        await announce(release);
        this.logger.info({ tag: release.tag }, 'Announced new release');
      }
      await this.writeState({ tag: release.tag, publishedAt: release.publishedAt });
    } finally {
      this.checking = false;
    }
  }

  /** Checks every `intervalMinutes`; returns a stop function. */
  start(intervalMinutes: number, announce: Announce): () => void {
    const run = () =>
      void this.check(announce).catch((err: unknown) => {
        this.logger.warn({ err }, 'Release check failed');
      });
    const first = setTimeout(run, FIRST_CHECK_MS);
    const timer = setInterval(run, intervalMinutes * 60_000);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  private async readState(): Promise<ReleaseState | undefined> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(this.statePath, 'utf8')));
      if (parsed.success) return parsed.data;
      this.logger.warn({ file: this.statePath }, 'Ignoring invalid release state');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return undefined;
  }

  private async writeState(state: ReleaseState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, this.statePath);
  }
}

/** Without dates, any other tag counts as newer. */
function isNewer(release: Release, known: ReleaseState): boolean {
  if (!release.publishedAt || !known.publishedAt) return true;
  return Date.parse(release.publishedAt) > Date.parse(known.publishedAt);
}
