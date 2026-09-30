import { describe, expect, it } from 'vitest';
import { compendiumToMarkdown, parseCompendium } from '../../src/rules/compendium.js';

const OUTPUT = [
  '@@monster\tBALR\tbalrog\t0',
  'balrog [BALR], weight 250. This monster has 200 melee attacks per round.',
  '',
  '@@illusion\tBALR\tbalrog\t0',
  'illusory balrog [IBALR], weight 1.',
  '',
  '@@item\tPARM\tplate armor\t0',
  'plate armor [PARM], weight 3.',
  '',
  '@@skill\tSSTO\tsummon storm\t1',
  'summon storm [SSTO] 1: A mage with this skill can cast summon storm in battle.',
  '',
  '@@skill\tSSTO\tsummon storm\t2',
  'summon storm [SSTO] 2: No skill report.',
  '',
  '@@object\t\tLair\t0',
  'Lair: Trents can potentially lair in this structure.',
  '',
  '@@object\t\tLair\t0',
  'Lair: Illyrthil can potentially lair in this structure.',
  '',
  '@@bogus\tX\tx\t0',
  'ignored',
  '',
].join('\n');

describe('parseCompendium', () => {
  it('parses entries and drops empty skill reports and unknown kinds', () => {
    const entries = parseCompendium(OUTPUT);
    expect(entries.map((e) => `${e.kind}:${e.abbr}:${e.level}`)).toEqual([
      'monster:BALR:0',
      'illusion:BALR:0',
      'item:PARM:0',
      'skill:SSTO:1',
      'object::0',
      'object::0',
    ]);
  });
});

describe('compendiumToMarkdown', () => {
  it('groups entries under sections with name [ABBR] headings', () => {
    const md = compendiumToMarkdown(parseCompendium(OUTPUT));
    expect(md).toContain('## Monsters\n\n### balrog [BALR]\n\nbalrog [BALR], weight 250.');
    expect(md).toContain(
      '## Skills and spells\n\n### summon storm [SSTO]\n\nLevel 1: A mage with this skill can cast summon storm in battle.',
    );
    expect(md).toContain(
      '### Lair\n\nLair: Trents can potentially lair in this structure.\n\nLair: Illyrthil',
    );
    expect(md.match(/### Lair/g)).toHaveLength(1);
    expect(md).toContain('## Illusions\n\n### illusory balrog [IBALR]');
    expect(md.match(/### balrog \[BALR\]/g)).toHaveLength(1);
    expect(md).not.toContain('No skill report');
  });
});
