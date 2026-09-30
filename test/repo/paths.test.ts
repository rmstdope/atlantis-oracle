import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathError, resolveInRepo, toRepoRelative } from '../../src/repo/paths.js';
import { FIXTURE_REPO } from '../helpers/fixture.js';

describe('resolveInRepo', () => {
  it('resolves files and directories inside the repo', async () => {
    const root = await realpath(FIXTURE_REPO);
    expect(await resolveInRepo(FIXTURE_REPO, 'gamedata.cpp')).toBe(path.join(root, 'gamedata.cpp'));
    expect(await resolveInRepo(FIXTURE_REPO, './standard/../standard/rules.cpp')).toBe(
      path.join(root, 'standard/rules.cpp'),
    );
    expect(await resolveInRepo(FIXTURE_REPO, '')).toBe(root);
    expect(await resolveInRepo(FIXTURE_REPO, '.')).toBe(root);
  });

  it.each([
    ['/etc/passwd'],
    ['../package.json'],
    ['standard/../../x'],
    ['..'],
    ['.git/config'],
    ['C:/Windows'],
  ])('rejects %s', async (p) => {
    await expect(resolveInRepo(FIXTURE_REPO, p)).rejects.toThrow(PathError);
  });

  it('rejects symlinks that escape the repo', async () => {
    await expect(resolveInRepo(FIXTURE_REPO, 'escape-link')).rejects.toThrow(/outside/);
  });

  it('reports missing files', async () => {
    await expect(resolveInRepo(FIXTURE_REPO, 'nope.cpp')).rejects.toThrow(/No such file/);
  });
});

describe('toRepoRelative', () => {
  it('returns POSIX relative paths', () => {
    expect(toRepoRelative('/a/b', '/a/b/c/d.cpp')).toBe('c/d.cpp');
    expect(toRepoRelative('/a/b', '/a/b')).toBe('.');
  });
});
