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
  /** The announcement, so it can follow later edits of the release. */
  messageId: z.string().optional(),
  /** Name and notes as last posted; absent in state from older versions. */
  name: z.string().optional(),
  notes: z.string().optional(),
});
type ReleaseState = z.infer<typeof stateSchema>;

/**
 * Posts and revises release announcements; throwing means it is tried again
 * next check.
 */
export interface Announcer {
  /** Posts a new release; returns the message ID, or undefined if it can't be revised. */
  post(release: Release): Promise<string | undefined>;
  /**
   * Rewrites a posted announcement after the release changed. Returns false
   * when the message can never be edited (deleted, or no access), so the
   * watcher stops trying.
   */
  revise(messageId: string, release: Release): Promise<boolean>;
}

/**
 * Knows the latest release: serves /latest-release from a short cache and,
 * when started, announces each new release once. The last announced release
 * is kept in a file, so restarts don't announce it again. Release notes are
 * often written after the release is published, so the announcement is
 * revised whenever the release's name, notes or date change.
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
   * deleted) is remembered silently. A changed name or notes on the known
   * release revise its announcement.
   */
  async check(announcer: Announcer): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const release = await this.refresh();
      if (!release) return;
      const known = await this.readState();
      const state: ReleaseState = {
        tag: release.tag,
        publishedAt: release.publishedAt,
        name: release.name,
        notes: release.notes,
      };
      if (known?.tag === release.tag) {
        if (
          known.name === release.name &&
          known.notes === release.notes &&
          known.publishedAt === release.publishedAt
        ) {
          return;
        }
        let messageId = known.messageId;
        // State from before revisions were tracked has no name/notes: just record them.
        if (messageId && known.notes !== undefined) {
          if (await announcer.revise(messageId, release)) {
            this.logger.info({ tag: release.tag }, 'Revised release announcement');
          } else {
            this.logger.warn(
              { tag: release.tag, messageId },
              'Release announcement can no longer be edited; not revising it again',
            );
            messageId = undefined;
          }
        }
        await this.writeState({ ...state, messageId });
        return;
      }
      let messageId: string | undefined;
      if (!known || isNewer(release, known)) {
        messageId = await announcer.post(release);
        this.logger.info({ tag: release.tag }, 'Announced new release');
      }
      await this.writeState({ ...state, messageId });
    } finally {
      this.checking = false;
    }
  }

  /** Checks every `intervalMinutes`; returns a stop function. */
  start(intervalMinutes: number, announcer: Announcer): () => void {
    const run = () =>
      void this.check(announcer).catch((err: unknown) => {
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
