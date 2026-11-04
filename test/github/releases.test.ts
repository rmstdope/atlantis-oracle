import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release } from '../../src/github/client.js';
import { ReleaseWatcher } from '../../src/github/releases.js';
import { silentLogger } from '../helpers/fixture.js';

const release = (tag: string, publishedAt: string | null, notes = ''): Release => ({
  tag,
  name: tag,
  url: `https://github.com/o/r/releases/tag/${tag}`,
  publishedAt,
  notes,
});

/** A fake announcer whose posts get IDs msg-1, msg-2, … */
const announcer = () => {
  let n = 0;
  return {
    post: vi.fn(async (_release: Release): Promise<string | undefined> => `msg-${++n}`),
    revise: vi.fn(async (_messageId: string, _release: Release) => {}),
  };
};

let dir: string;
let file: string;
let now: number;
const source = { latestRelease: vi.fn<() => Promise<Release | null>>() };
const watcher = () => new ReleaseWatcher(source, file, silentLogger, () => now);
const state = async () => JSON.parse(await readFile(file, 'utf8'));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'oracle-releases-'));
  file = path.join(dir, 'sub', 'latest-release.json');
  now = 1_000_000;
  vi.resetAllMocks();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ReleaseWatcher.check', () => {
  it('announces the current release on the very first check', async () => {
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z', 'notes'));
    const a = announcer();
    await watcher().check(a);
    expect(a.post).toHaveBeenCalledWith(expect.objectContaining({ tag: 'v1' }));
    expect(await state()).toEqual({
      tag: 'v1',
      publishedAt: '2026-10-01T00:00:00Z',
      messageId: 'msg-1',
      name: 'v1',
      notes: 'notes',
    });
  });

  it('announces a newer release once, also across restarts', async () => {
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z'));
    await watcher().check(announcer());
    source.latestRelease.mockResolvedValue(release('v2', '2026-11-01T00:00:00Z'));
    const a = announcer();
    await watcher().check(a);
    await watcher().check(a);
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(a.post).toHaveBeenCalledWith(expect.objectContaining({ tag: 'v2' }));
    expect(a.revise).not.toHaveBeenCalled();
  });

  it('revises the announcement when the notes are written after publishing', async () => {
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z', '## Installing'));
    const a = announcer();
    await watcher().check(a);
    source.latestRelease.mockResolvedValue(
      release('v1', '2026-10-01T00:00:00Z', "What's new for you"),
    );
    await watcher().check(a);
    await watcher().check(a);
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(a.revise).toHaveBeenCalledTimes(1);
    expect(a.revise).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({ notes: "What's new for you" }),
    );
    expect(await state()).toMatchObject({ messageId: 'msg-1', notes: "What's new for you" });
  });

  it('retries a revision that failed', async () => {
    await writeFileSafe({ tag: 'v1', publishedAt: null, messageId: 'm', name: 'v1', notes: 'a' });
    source.latestRelease.mockResolvedValue(release('v1', null, 'b'));
    const a = announcer();
    a.revise.mockRejectedValueOnce(new Error('discord down'));
    await expect(watcher().check(a)).rejects.toThrow('discord down');
    await watcher().check(a);
    expect(a.revise).toHaveBeenCalledTimes(2);
    expect((await state()).notes).toBe('b');
  });

  it('records the notes silently for state from older versions', async () => {
    await writeFileSafe({ tag: 'v1', publishedAt: '2026-10-01T00:00:00Z' });
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z', 'notes'));
    const a = announcer();
    await watcher().check(a);
    expect(a.post).not.toHaveBeenCalled();
    expect(a.revise).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({ tag: 'v1', notes: 'notes' });
  });

  it('retries an announcement that failed', async () => {
    await writeFileSafe({ tag: 'v1', publishedAt: '2026-10-01T00:00:00Z' });
    source.latestRelease.mockResolvedValue(release('v2', '2026-11-01T00:00:00Z'));
    const a = announcer();
    a.post.mockRejectedValueOnce(new Error('discord down'));
    await expect(watcher().check(a)).rejects.toThrow('discord down');
    await watcher().check(a);
    expect(a.post).toHaveBeenCalledTimes(2);
  });

  it('silently accepts an older release after the newest was deleted', async () => {
    await writeFileSafe({ tag: 'v2', publishedAt: '2026-11-01T00:00:00Z', messageId: 'm2' });
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z'));
    const a = announcer();
    await watcher().check(a);
    expect(a.post).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({ tag: 'v1' });
    expect((await state()).messageId).toBeUndefined();
  });

  it('does nothing while there are no releases', async () => {
    source.latestRelease.mockResolvedValue(null);
    await watcher().check(announcer());
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});

describe('ReleaseWatcher.latest', () => {
  it('reuses a lookup for 10 minutes and shares it with check', async () => {
    source.latestRelease.mockResolvedValue(release('v1', null));
    const w = watcher();
    await w.latest();
    now += 5 * 60_000;
    await w.latest();
    expect(source.latestRelease).toHaveBeenCalledTimes(1);
    now += 6 * 60_000;
    expect(await w.latest()).toMatchObject({ tag: 'v1' });
    expect(source.latestRelease).toHaveBeenCalledTimes(2);

    source.latestRelease.mockResolvedValue(release('v2', null));
    await w.check(announcer());
    expect(await w.latest()).toMatchObject({ tag: 'v2' });
    expect(source.latestRelease).toHaveBeenCalledTimes(3);
  });
});

async function writeFileSafe(state: object): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}
