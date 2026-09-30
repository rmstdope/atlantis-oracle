import { describe, expect, it } from 'vitest';
import { findAbbreviations, glossaryNote } from '../../src/llm/glossary.js';
import { FIXTURE_REPO } from '../helpers/fixture.js';

describe('findAbbreviations', () => {
  it('maps all-caps item and skill abbreviations to names', async () => {
    const found = await findAbbreviations(
      FIXTURE_REPO,
      'Does PARM help against TACT? And TACT again, parm, XYZZY.',
    );
    expect(found).toEqual([
      { abbr: 'PARM', kind: 'item', name: 'plate armor' },
      { abbr: 'TACT', kind: 'skill', name: 'tactics' },
    ]);
  });

  it('distinguishes items and skills sharing an abbreviation', async () => {
    // ARMO is the armorer skill; no item uses it in the fixture.
    expect(await findAbbreviations(FIXTURE_REPO, 'ARMO')).toEqual([
      { abbr: 'ARMO', kind: 'skill', name: 'armorer' },
    ]);
  });

  it('returns nothing without abbreviations or without gamedata', async () => {
    expect(await findAbbreviations(FIXTURE_REPO, 'how does combat work?')).toEqual([]);
    expect(await findAbbreviations('/nonexistent', 'SSTO')).toEqual([]);
  });
});

describe('glossaryNote', () => {
  it('formats a note', () => {
    expect(glossaryNote([])).toBeUndefined();
    expect(glossaryNote([{ abbr: 'SSTO', kind: 'skill', name: 'summon storm' }])).toBe(
      'Game abbreviations in the question: SSTO = skill "summon storm". The rules use the full names.',
    );
  });
});
