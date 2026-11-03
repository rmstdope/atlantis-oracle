import { describe, expect, it } from 'vitest';
import { parseGuide, resolveGuide } from '../../src/guide/store.js';
import { lookupTopic, readGuide, topicIndex } from '../../src/tools/guide.js';
import { runTool, type ToolContext } from '../../src/tools/index.js';
import { FIXTURE_REPO } from '../helpers/fixture.js';

const { topics } = parseGuide(`## Combat: hit odds
How an attack is rolled.
- \`ItemDefs\` (gamedata.cpp): stands in for an engine symbol.

## Spoils and monster treasure
What winners pick up after a battle.
- \`MAX_SPEED\` (standard/rules.cpp): stands in for a constant.

## Taxing and pillaging
Income from TAX and PILLAGE and who may collect it.
- \`Gone\` (gamedata.cpp): missing symbol.
`);
const guide = await resolveGuide(topics, FIXTURE_REPO, 'abc');
const ctx: ToolContext = { root: FIXTURE_REPO, variant: 'standard', guide };
const run = (args: unknown) => runTool([readGuide], 'read_guide', JSON.stringify(args), ctx);

describe('lookupTopic', () => {
  it('matches exact, partial and word-overlap queries', () => {
    expect(lookupTopic(guide, 'combat: hit odds')?.title).toBe('Combat: hit odds');
    expect(lookupTopic(guide, 'Spoils')?.title).toBe('Spoils and monster treasure');
    expect(lookupTopic(guide, 'tax income')?.title).toBe('Taxing and pillaging');
    expect(lookupTopic(guide, 'how are attacks rolled')?.title).toBe('Combat: hit odds');
    expect(lookupTopic(guide, 'zzz')).toBeUndefined();
  });
  it('lists the topics for the system prompt', () => {
    expect(topicIndex(guide)).toBe(
      'Combat: hit odds; Spoils and monster treasure; Taxing and pillaging',
    );
  });
});

describe('read_guide', () => {
  it('lists topics without arguments', async () => {
    const r = await run({});
    expect(r.ok).toBe(true);
    expect(r.output).toBe(
      '- Combat: hit odds: How an attack is rolled.\n' +
        '- Spoils and monster treasure: What winners pick up after a battle.\n' +
        '- Taxing and pillaging: Income from TAX and PILLAGE and who may collect it.',
    );
  });
  it('returns resolved pointers for a topic', async () => {
    const r = await run({ topic: 'spoils' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('## Spoils and monster treasure');
    expect(r.output).toContain('- standard/rules.cpp:10 MAX_SPEED: stands in for a constant.');
  });
  it('marks entries that no longer resolve', async () => {
    const r = await run({ topic: 'pillage' });
    expect(r.output).toContain('Gone (gamedata.cpp, not found in this commit; search_code for it)');
  });
  it('explains unknown topics and a missing guide', async () => {
    const r = await run({ topic: 'weather' });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/No guide topic matches "weather"\. Topics: Combat: hit odds;/);
    const none = await runTool([readGuide], 'read_guide', '{}', { ...ctx, guide: undefined });
    expect(none).toEqual({ ok: false, output: expect.stringMatching(/No code guide/) });
  });
});
