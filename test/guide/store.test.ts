import { describe, expect, it } from 'vitest';
import {
  findSymbolLine,
  formatTopic,
  GuideStore,
  parseGuide,
  resolveGuide,
} from '../../src/guide/store.js';
import { FIXTURE_REPO, silentLogger } from '../helpers/fixture.js';

const GUIDE = `# Atlantis code guide

Preamble that is not a topic.

## Items and data tables
The base tables live in gamedata.cpp; variants change them in extra.cpp.
- \`ItemDefs\` (gamedata.cpp): every item's weight, type flags and base price.
- \`Game::ModifyTablesPerRuleset\` (standard/extra.cpp): the variant's changes to the tables.

## Variant constants
Speeds and limits per variant.
- \`MAX_SPEED\` (standard/rules.cpp): base movement points.
- \`NoSuchThing\` (standard/rules.cpp): does not exist.
- \`Whatever\` (missing/file.cpp): file does not exist.
- a bullet that is not an entry

## Empty topic
`;

describe('parseGuide', () => {
  it('splits topics, intros and entries and reports what it cannot parse', () => {
    const { topics, warnings } = parseGuide(GUIDE);
    expect(topics.map((t) => t.title)).toEqual([
      'Items and data tables',
      'Variant constants',
      'Empty topic',
    ]);
    expect(topics[0]).toMatchObject({
      intro: 'The base tables live in gamedata.cpp; variants change them in extra.cpp.',
      entries: [
        { symbol: 'ItemDefs', path: 'gamedata.cpp', note: expect.stringMatching(/^every item/) },
        { symbol: 'Game::ModifyTablesPerRuleset', path: 'standard/extra.cpp' },
      ],
    });
    expect(warnings).toEqual([
      expect.stringMatching(/Variant constants: unparsed entry "- a bullet/),
      'Empty topic: no entries',
    ]);
  });
});

describe('findSymbolLine', () => {
  const lines = [
    '#include "x.h"',
    'int Hits(int a, int d);',
    '	if (Hits(a, d)) return;',
    'int Hits(int a, int d)',
    '{',
    'int Army::DoAnAttack(Battle *b)',
    '	50,	// TAX_INCOME',
    'std::vector<ItemType> ItemDefs =',
  ];
  it('prefers definitions at column 0 over calls and declarations', () => {
    expect(findSymbolLine(lines, 'Hits')).toBe(2); // first column-0 line with Hits(
    expect(findSymbolLine(lines, 'Army::DoAnAttack')).toBe(6);
    expect(findSymbolLine(lines, 'ItemDefs')).toBe(8);
  });
  it('falls back to the first whole-word mention', () => {
    expect(findSymbolLine(lines, 'TAX_INCOME')).toBe(7);
    expect(findSymbolLine(lines, 'TAX')).toBeUndefined();
  });
});

describe('resolveGuide', () => {
  it('turns symbols into lines against the repo and lists what is missing', async () => {
    const { topics } = parseGuide(GUIDE);
    const guide = await resolveGuide(topics, FIXTURE_REPO, 'abc');
    const [items, variant] = guide.topics;
    expect(items!.entries[0]).toMatchObject({ symbol: 'ItemDefs', line: 12 });
    expect(items!.entries[1]!.line).toBeGreaterThan(0);
    expect(variant!.entries[0]).toMatchObject({ symbol: 'MAX_SPEED', line: 10 });
    expect(variant!.entries[1]!.line).toBeUndefined();
    expect(guide.unresolved).toEqual([
      'Variant constants: NoSuchThing (standard/rules.cpp)',
      'Variant constants: Whatever (missing/file.cpp)',
    ]);
    const text = formatTopic(variant!);
    expect(text).toContain('- standard/rules.cpp:10 MAX_SPEED: base movement points.');
    expect(text).toContain('NoSuchThing (standard/rules.cpp, not found in this commit');
    expect(text).toContain('read_file');
  });

  it('rejects paths outside the repo instead of reading them', async () => {
    const { topics } = parseGuide(
      '## T\n- `x` (../../package.json): escape.\n- `y` (escape-link): symlink.\n',
    );
    const guide = await resolveGuide(topics, FIXTURE_REPO, 'abc');
    expect(guide.unresolved).toHaveLength(2);
  });
});

describe('GuideStore', () => {
  it('is empty without a guide file and caches per commit', async () => {
    const missing = new GuideStore('/nonexistent/guide.md', silentLogger);
    await missing.prepare({ dir: FIXTURE_REPO, commit: 'a' });
    expect(missing.get()).toBeUndefined();

    const store = new GuideStore('test/fixtures/code-guide.md', silentLogger);
    await store.prepare({ dir: FIXTURE_REPO, commit: 'a' });
    const first = store.get();
    expect(first?.topics.map((t) => t.title)).toEqual(['Items and data tables']);
    await store.prepare({ dir: FIXTURE_REPO, commit: 'a' });
    expect(store.get()).toBe(first);
    await store.prepare({ dir: FIXTURE_REPO, commit: 'b' });
    expect(store.get()).not.toBe(first);
    expect(store.get()?.commit).toBe('b');
  });
});
