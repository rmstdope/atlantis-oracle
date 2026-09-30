import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRulesBuilder, type BuiltRules, type RulesBuilder } from '../../src/rules/build.js';
import { RulesStore } from '../../src/rules/store.js';
import { FIXTURE_REPO, silentLogger } from '../helpers/fixture.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'oracle-rules-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const repo = (commit: string) => ({
  dir: FIXTURE_REPO,
  commit,
  variants: ['neworigins', 'standard'],
});

/** A builder that "builds" rules only for the given variants. */
function fakeBuilder(variants: string[]): RulesBuilder & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async ({ variants: requested, workDir }) => {
    calls.push(requested);
    const out = new Map<string, BuiltRules>();
    for (const v of requested.filter((r) => variants.includes(r))) {
      const file = path.join(tmp, `${v}.built.html`);
      await writeFile(file, `<h2>${v} built rules</h2><p>Built for ${path.basename(workDir)}.</p>`);
      out.set(v, {
        html: file,
        compendium: `@@monster\tBALR\tbalrog\t0\nbalrog [BALR], ${v} edition.\n\n`,
      });
    }
    return out;
  }) as RulesBuilder & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe('RulesStore', () => {
  it('prefers built rules, falls back to snapshots, and caches per commit', async () => {
    const builder = fakeBuilder(['neworigins']);
    const store = new RulesStore({ dir: tmp, build: true }, silentLogger, builder);
    await store.prepare(repo('c1'));

    expect(store.variants).toEqual(['neworigins', 'standard']);
    expect(store.get('neworigins')).toMatchObject({
      source: 'built',
      commit: 'c1',
      compendium: true,
    });
    expect(store.get('neworigins')!.lines).toContain('## neworigins built rules');
    expect(store.get('neworigins')!.lines).toContain('### balrog [BALR]');
    expect(store.get('neworigins')!.headings.map((h) => h.text)).toContain('Monsters');
    // standard failed to build, so the committed snapshot is used.
    expect(store.get('standard')).toMatchObject({
      source: 'snapshot',
      commit: 'c1',
      compendium: false,
    });
    expect(store.get('standard')!.headings.map((h) => h.text)).toContain('Tactics');

    // Same commit: nothing is rebuilt, even by a new store reading from disk.
    const again = new RulesStore({ dir: tmp, build: true }, silentLogger, builder);
    await again.prepare(repo('c1'));
    expect(builder.calls).toEqual([['neworigins', 'standard']]);
    expect(again.get('neworigins')!.source).toBe('built');

    // New commit: rebuilt.
    await again.prepare(repo('c2'));
    expect(builder.calls).toHaveLength(2);
    expect(again.get('standard')!.commit).toBe('c2');
  });

  it('rebuilds cached rules written in an older format', async () => {
    const builder = fakeBuilder(['neworigins']);
    await new RulesStore({ dir: tmp, build: true }, silentLogger, builder).prepare(repo('c1'));
    const metaFile = path.join(tmp, 'neworigins.md.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
    await writeFile(metaFile, JSON.stringify({ ...meta, format: 1 }));
    await new RulesStore({ dir: tmp, build: true }, silentLogger, builder).prepare(repo('c1'));
    expect(builder.calls).toHaveLength(2);
  });

  it('keeps outdated rules when no current ones can be made', async () => {
    const store = new RulesStore(
      { dir: tmp, build: true },
      silentLogger,
      fakeBuilder(['neworigins']),
    );
    await store.prepare(repo('c1'));
    const failing: RulesBuilder = async () => {
      throw new Error('compiler exploded');
    };
    const later = new RulesStore({ dir: tmp, build: true }, silentLogger, failing);
    await later.prepare(repo('c2'));
    // neworigins has no snapshot: the c1 build stays in use.
    expect(later.get('neworigins')).toMatchObject({ commit: 'c1', source: 'built' });
    expect(later.get('standard')).toMatchObject({ commit: 'c2', source: 'snapshot' });
  });

  it('does not build when building is disabled', async () => {
    const builder = vi.fn(fakeBuilder(['standard']));
    const store = new RulesStore({ dir: tmp, build: false }, silentLogger, builder);
    await store.prepare(repo('c1'));
    expect(builder).not.toHaveBeenCalled();
    expect(store.variants).toEqual(['standard']);
  });
});

describe('makeRulesBuilder', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  it('builds with the repo Makefile and runs genrules, skipping failing variants', async () => {
    const src = path.join(tmp, 'game');
    execFileSync('mkdir', ['-p', path.join(src, 'standard'), path.join(src, 'broken')]);
    // A "game binary" that writes the rules file given as its 4th argument.
    await writeFile(
      path.join(src, 'Makefile'),
      [
        'GAME ?= standard',
        'all:',
        '\ttest "$(GAME)" != broken',
        '\tprintf \'#!/bin/sh\\necho "<h2>$(GAME) rules from $$2</h2>" > "$$4"\\n\' > $(GAME)/$(GAME)',
        '\tchmod +x $(GAME)/$(GAME)',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(src, 'standard', 'standard_intro.html'), 'intro');
    await writeFile(path.join(src, 'broken', 'broken_intro.html'), 'intro');
    git(src, 'init', '-q');
    git(src, 'add', '.');
    git(src, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'x');

    const built = await makeRulesBuilder({
      repoDir: src,
      variants: ['standard', 'broken', 'nointro'],
      workDir: path.join(tmp, 'work'),
      logger: silentLogger,
    });
    expect([...built.keys()]).toEqual(['standard']);
    // No engine objects in this fake game, so the compendium is skipped.
    expect(built.get('standard')!.compendium).toBeUndefined();
    expect(await readFile(built.get('standard')!.html, 'utf8')).toBe(
      '<h2>standard rules from standard/standard_intro.html</h2>\n',
    );
    // The clone itself stays clean.
    expect(git(src, 'status', '--porcelain')).toBe('');
  });
});
