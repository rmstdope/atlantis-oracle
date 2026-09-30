import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverVariants, GameRepo } from '../../src/repo/sync.js';
import { FIXTURE_REPO, silentLogger } from '../helpers/fixture.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('GameRepo', () => {
  let tmp: string;
  let origin: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'oracle-sync-'));
    origin = path.join(tmp, 'origin');
    await mkdir(path.join(origin, 'standard'), { recursive: true });
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'user.email', 'test@example.com');
    git(origin, 'config', 'user.name', 'Test');
    await writeFile(path.join(origin, 'standard/rules.cpp'), '// v1\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'v1');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const makeRepo = (branch?: string) =>
    new GameRepo(
      { url: `file://${origin}`, branch, dir: path.join(tmp, 'clone'), syncIntervalMinutes: 0 },
      silentLogger,
    );

  it('clones, then picks up new commits and discards local changes', async () => {
    const repo = makeRepo();
    await repo.sync();
    expect(repo.commit).toBe(git(origin, 'rev-parse', 'HEAD'));
    expect(repo.branch).toBe('main');
    expect(repo.variants).toEqual(['standard']);
    expect(repo.lastSyncedAt).toBeInstanceOf(Date);

    await mkdir(path.join(origin, 'fracas'));
    await writeFile(path.join(origin, 'fracas/rules.cpp'), '// fracas\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'v2');
    await writeFile(path.join(repo.dir, 'standard/rules.cpp'), '// local edit\n');

    await repo.sync();
    expect(repo.commit).toBe(git(origin, 'rev-parse', 'HEAD'));
    expect(repo.variants).toEqual(['fracas', 'standard']);
    expect(git(repo.dir, 'status', '--porcelain')).toBe('');
  });

  it('checks out a configured branch', async () => {
    git(origin, 'checkout', '-q', '-b', 'dev');
    await writeFile(path.join(origin, 'standard/rules.cpp'), '// dev\n');
    git(origin, 'commit', '-q', '-am', 'dev');
    const devCommit = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');

    const repo = makeRepo('dev');
    await repo.sync();
    expect(repo.commit).toBe(devCommit);
    expect(repo.branch).toBe('dev');
  });

  it('loads an existing clone without syncing', async () => {
    await makeRepo().sync();
    const repo = makeRepo();
    await repo.loadExisting();
    expect(repo.commit).toBe(git(origin, 'rev-parse', 'HEAD'));
    expect(repo.variants).toEqual(['standard']);
    expect(repo.lastSyncedAt).toBeUndefined();
  });

  it('refuses to load a missing clone', async () => {
    await expect(makeRepo().loadExisting()).rejects.toThrow(/sync it first/);
  });

  it('serializes concurrent syncs', async () => {
    const repo = makeRepo();
    await Promise.all([repo.sync(), repo.sync()]);
    expect(repo.commit).toBe(git(origin, 'rev-parse', 'HEAD'));
  });

  it('fails on an unreachable remote', async () => {
    const repo = new GameRepo(
      {
        url: `file://${tmp}/missing`,
        branch: undefined,
        dir: path.join(tmp, 'c2'),
        syncIntervalMinutes: 0,
      },
      silentLogger,
    );
    await expect(repo.sync()).rejects.toThrow();
  });
});

describe('discoverVariants', () => {
  it('finds directories containing rules.cpp', async () => {
    expect(await discoverVariants(FIXTURE_REPO)).toEqual(['neworigins', 'standard']);
  });
});
