import { describe, expect, it } from 'vitest';
import { defaultTools, runTool, toOpenAITools } from '../../src/tools/index.js';
import { truncate } from '../../src/tools/types.js';
import { FIXTURE_REPO } from '../helpers/fixture.js';

const ctx = { root: FIXTURE_REPO };
const run = (name: string, args: unknown) =>
  runTool(defaultTools, name, typeof args === 'string' ? args : JSON.stringify(args), ctx);

describe('runTool', () => {
  it('reports unknown tools', async () => {
    const r = await run('delete_everything', {});
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/unknown tool.*search_code/);
  });

  it('reports malformed JSON', async () => {
    const r = await run('read_file', '{"path": ');
    expect(r).toEqual({ ok: false, output: expect.stringMatching(/not valid JSON/) });
  });

  it('reports schema violations', async () => {
    const r = await run('read_file', { path: 'gamedata.cpp', start_line: 0 });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/invalid arguments for read_file: start_line/);
  });

  it('turns sandbox violations into errors', async () => {
    const r = await run('read_file', { path: '../../../package.json' });
    expect(r).toEqual({ ok: false, output: expect.stringMatching(/outside the repository/) });
  });
});

describe('toOpenAITools', () => {
  it('produces function tools with JSON schema parameters', () => {
    const tools = toOpenAITools(defaultTools);
    expect(tools.map((t) => t.function.name)).toEqual([
      'search_code',
      'read_file',
      'list_dir',
      'find_definition',
    ]);
    const read = tools[1]!.function.parameters as Record<string, unknown>;
    expect(read.type).toBe('object');
    expect(read.required).toEqual(['path']);
    expect(read).not.toHaveProperty('$schema');
  });
});

describe('search_code', () => {
  it('finds matches with line numbers and skips external/', async () => {
    const r = await run('search_code', { pattern: 'allowedMages', context: 0 });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('standard/rules.cpp:5:int *allowedMages = am;');
    expect(r.output).toContain('neworigins/rules.cpp:');
    expect(r.output).not.toContain('external/');
  });

  it('restricts by path and glob', async () => {
    const byPath = await run('search_code', { pattern: 'allowedMages', path: 'neworigins' });
    expect(byPath.output).not.toContain('standard/');
    const byGlob = await run('search_code', { pattern: 'EnableItem', glob: '*/extra.cpp' });
    expect(byGlob.output).toContain('standard/extra.cpp:3:');
  });

  it('is case-insensitive for lowercase patterns', async () => {
    const r = await run('search_code', { pattern: 'plate armor', context: 0 });
    expect(r.output).toContain('gamedata.cpp:23:');
  });

  it('supports fixed strings', async () => {
    const r = await run('search_code', { pattern: 'I_IRON,3', fixed_strings: true, context: 0 });
    expect(r.output).toContain('gamedata.cpp:25:');
  });

  it('reports no matches and bad regexes', async () => {
    expect((await run('search_code', { pattern: 'xyzzy' })).output).toMatch(/No matches/);
    const bad = await run('search_code', { pattern: '(unclosed' });
    expect(bad.ok).toBe(false);
    expect(bad.output).toMatch(/search failed/);
  });
});

describe('read_file', () => {
  it('returns numbered lines with a header', async () => {
    const r = await run('read_file', { path: 'standard/rules.cpp', start_line: 4, end_line: 5 });
    expect(r.output).toBe(
      'standard/rules.cpp (lines 4-5 of 11 — continue with start_line 6)\n' +
        '4| static int am[] = { 0, 1, 2, 3, 5, 7 };\n' +
        '5| int *allowedMages = am;',
    );
  });

  it('clamps to the end of the file', async () => {
    const r = await run('read_file', { path: 'standard/extra.cpp', start_line: 4, end_line: 100 });
    expect(r.output).toMatch(/^standard\/extra.cpp \(lines 4-5 of 5\)\n/);
  });

  it('rejects directories and out-of-range starts', async () => {
    expect((await run('read_file', { path: 'standard' })).output).toMatch(
      /directory; use list_dir/,
    );
    expect((await run('read_file', { path: 'standard/extra.cpp', start_line: 50 })).output).toMatch(
      /only 5 lines/,
    );
  });
});

describe('list_dir', () => {
  it('lists directories first', async () => {
    const r = await run('list_dir', {});
    const lines = r.output.split('\n');
    expect(lines[0]).toMatch(/^\.\/ \(\d+ entries\)$/);
    expect(lines.indexOf('standard/')).toBeLessThan(lines.indexOf('gamedata.cpp'));
  });

  it('rejects files', async () => {
    expect((await run('list_dir', { path: 'gamedata.cpp' })).output).toMatch(/is a file/);
  });
});

describe('find_definition', () => {
  it('finds an item by name with its enum and legend', async () => {
    const r = await run('find_definition', { query: 'Plate Armor' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('ItemDefs[2] (enum I_PLATEARMOR) — gamedata.cpp:23-26');
    expect(r.output).toContain('// name, plural, abbr,');
    expect(r.output).toContain('25|  "ARMO",3,3,1, {{I_IRON,3},{-1,0},{-1,0},{-1,0}},');
    expect(r.output).not.toContain('ArmorDefs');
    expect(r.output).toContain('search for I_PLATEARMOR in */extra.cpp');
  });

  it('finds by abbreviation across tables', async () => {
    const r = await run('find_definition', { query: 'PARM' });
    expect(r.output).toContain('ItemDefs[2]');
    expect(r.output).not.toContain('// ARMOR_PLATEARMOR');
    expect(r.output).toContain('ArmorDefs[0] — gamedata.cpp:36\n');
  });

  it('finds by enum constant and filters by table', async () => {
    const r = await run('find_definition', { query: 'S_TACTICS' });
    expect(r.output).toContain('SkillDefs[1] (enum S_TACTICS)');
    const t = await run('find_definition', { query: 'PARM', table: 'armordefs' });
    expect(t.output).not.toContain('ItemDefs');
  });

  it('is not confused by braces in comments', async () => {
    const r = await run('find_definition', { query: 'iron' });
    expect(r.output).toContain('ItemDefs[1] (enum I_IRON) — gamedata.cpp:19-22');
  });

  it('suggests similar entries', async () => {
    const r = await run('find_definition', { query: 'armor' });
    expect(r.output).toMatch(/No exact match.*plate armor \(ItemDefs\)/);
  });

  it('reports unknown tables', async () => {
    const r = await run('find_definition', { query: 'x', table: 'FooDefs' });
    expect(r.output).toMatch(/Unknown table.*ItemDefs, ArmorDefs, SkillDefs/);
  });
});

describe('truncate', () => {
  it('cuts on a line boundary and notes the rest', () => {
    const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n');
    expect(truncate(text, 10, 'hint')).toBe('aaaa\nbbbb\n[truncated: 2 more lines, hint]');
    expect(truncate(text, 100)).toBe(text);
  });
});
