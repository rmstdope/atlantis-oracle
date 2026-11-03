import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release } from '../../src/github/client.js';
import { ReleaseWatcher } from '../../src/github/releases.js';
import { silentLogger } from '../helpers/fixture.js';

const release = (tag: string, publishedAt: string | null): Release => ({
  tag,
  name: tag,
  url: `https://github.com/o/r/releases/tag/${tag}`,
  publishedAt,
  notes: '',
});

let dir: string;
let file: string;
let now: number;
const source = { latestRelease: vi.fn<() => Promise<Release | null>>() };
const watcher = () => new ReleaseWatcher(source, file, silentLogger, () => now);

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
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z'));
    const announce = vi.fn(async () => {});
    await watcher().check(announce);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ tag: 'v1' }));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      tag: 'v1',
      publishedAt: '2026-10-01T00:00:00Z',
    });
  });

  it('announces a newer release once, also across restarts', async () => {
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z'));
    await watcher().check(vi.fn());
    source.latestRelease.mockResolvedValue(release('v2', '2026-11-01T00:00:00Z'));
    const announce = vi.fn(async () => {});
    await watcher().check(announce);
    await watcher().check(announce);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ tag: 'v2' }));
  });

  it('retries an announcement that failed', async () => {
    await writeFileSafe({ tag: 'v1', publishedAt: '2026-10-01T00:00:00Z' });
    source.latestRelease.mockResolvedValue(release('v2', '2026-11-01T00:00:00Z'));
    const announce = vi.fn().mockRejectedValueOnce(new Error('discord down'));
    await expect(watcher().check(announce)).rejects.toThrow('discord down');
    await watcher().check(announce);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('silently accepts an older release after the newest was deleted', async () => {
    await writeFileSafe({ tag: 'v2', publishedAt: '2026-11-01T00:00:00Z' });
    source.latestRelease.mockResolvedValue(release('v1', '2026-10-01T00:00:00Z'));
    const announce = vi.fn();
    await watcher().check(announce);
    expect(announce).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, 'utf8')).tag).toBe('v1');
  });

  it('does nothing while there are no releases', async () => {
    source.latestRelease.mockResolvedValue(null);
    await watcher().check(vi.fn());
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
    await w.check(vi.fn());
    expect(await w.latest()).toMatchObject({ tag: 'v2' });
    expect(source.latestRelease).toHaveBeenCalledTimes(3);
  });
});

async function writeFileSafe(state: object): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}
