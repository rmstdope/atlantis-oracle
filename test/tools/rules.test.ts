import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RulesStore } from '../../src/rules/store.js';
import { defaultTools, runTool, type ToolContext } from '../../src/tools/index.js';
import { FIXTURE_REPO, silentLogger } from '../helpers/fixture.js';

let tmp: string;
let ctx: ToolContext;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'oracle-rules-tools-'));
  const rules = new RulesStore({ dir: tmp, build: false }, silentLogger);
  await rules.prepare({ dir: FIXTURE_REPO, commit: 'c1', variants: ['standard', 'neworigins'] });
  ctx = { root: FIXTURE_REPO, variant: 'standard', rules };
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const run = (name: string, args: unknown, c: ToolContext = ctx) =>
  runTool(defaultTools, name, JSON.stringify(args), c);

describe('search_rules', () => {
  it('returns matching lines grouped by section', async () => {
    const r = await run('search_rules', { pattern: 'tactic' });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^3 matches in the standard rules:/);
    expect(r.output).toMatch(/§ Rules for Wyreth > Skills > Studying\n {2}\d+: Most skills cost/);
    expect(r.output).toMatch(
      /§ Rules for Wyreth > Combat > Tactics\n {2}\d+: ### Tactics:\n {2}\d+: If one side/,
    );
  });

  it('falls back to literal text for regex syntax', async () => {
    const r = await run('search_rules', { pattern: '$200 (' });
    expect(r.output).toMatch(/No matches/);
    expect((await run('search_rules', { pattern: '$200' })).output).toMatch(/1 matches/);
  });

  it('reports variants without rules', async () => {
    const r = await run('search_rules', { pattern: 'x', variant: 'neworigins' });
    expect(r).toEqual({
      ok: false,
      output: expect.stringMatching(/No rules available for "neworigins" \(available: standard\)/),
    });
    const none = await run(
      'search_rules',
      { pattern: 'x' },
      { root: FIXTURE_REPO, variant: 'standard' },
    );
    expect(none.output).toMatch(/available: none/);
  });
});

describe('read_rules', () => {
  it('lists sections without arguments', async () => {
    const r = await run('read_rules', {});
    expect(r.output).toMatch(/^Sections of the standard rules/);
    expect(r.output).toMatch(/\n {4}\d+: Studying/);
  });

  it('reads a section up to the next heading of the same level', async () => {
    const r = await run('read_rules', { section: 'studying' });
    expect(r.output).toMatch(
      /^standard rules § Rules for Wyreth > Skills > Studying \(lines \d+-\d+\)/,
    );
    expect(r.output).toContain('Tactics costs $200');
    expect(r.output).not.toContain('## Combat');

    const trail = await run('read_rules', { section: 'Skills > Studying' });
    expect(trail.output).toMatch(/^standard rules § Rules for Wyreth > Skills > Studying/);
    const tactics = await run('read_rules', { section: 'Combat > Tactics:' });
    expect(tactics.output).toContain('free round');

    const parent = await run('read_rules', { section: 'Playing' });
    expect(parent.output).toContain('### Factions');
    expect(parent.output).toContain('Magic (max mages)');
    expect(parent.output).not.toContain('## Skills');
  });

  it('reads line ranges and rejects unknown sections', async () => {
    const r = await run('read_rules', { start_line: 1, end_line: 2 });
    expect(r.output).toMatch(/^standard rules, § .* \(lines 1-2 of \d+\)\n1\| # Rules for Wyreth/);
    expect((await run('read_rules', { section: 'Nonexistent' })).output).toMatch(
      /No section matching/,
    );
  });
});
