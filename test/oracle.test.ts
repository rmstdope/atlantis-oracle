import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { GuideStore } from '../src/guide/store.js';
import { Oracle } from '../src/oracle.js';
import type { GameRepo } from '../src/repo/sync.js';
import type { RulesDoc, RulesStore } from '../src/rules/store.js';
import { fakeLlm, reply } from './helpers/fakeLlm.js';
import { FIXTURE_REPO, silentLogger } from './helpers/fixture.js';

// Plan and review steps are covered by the agent tests; keep these scripts short.
const config = loadConfig({
  OPENAI_API_KEY: 'k',
  LLM_MODEL: 'm',
  DEFAULT_GAME_VARIANT: 'standard',
  LLM_PLAN_STEP: 'false',
  LLM_REVIEW_STEP: 'false',
});
const repo = {
  dir: FIXTURE_REPO,
  commit: 'abcdef1234567890',
  variants: ['neworigins', 'standard'],
} as GameRepo;
const doc = { variant: 'standard', lines: ['# Rules'], headings: [] } as unknown as RulesDoc;
const rules = {
  get: (v: string) => (v === 'standard' ? doc : undefined),
  variants: ['standard'],
} as unknown as RulesStore;

const makeOracle = (llm = fakeLlm([])) =>
  new Oracle({ config, repo, rules, llm, logger: silentLogger });

describe('Oracle', () => {
  it('resolves variants case-insensitively with a default fallback', () => {
    const oracle = makeOracle();
    expect(oracle.resolveVariant('NewOrigins')).toBe('neworigins');
    expect(oracle.resolveVariant('bogus')).toBe('standard');
    expect(oracle.resolveVariant(undefined)).toBe('standard');
  });

  it('offers only rules tools first when rules exist', async () => {
    // Answering without tools earns one reminder to check the rules.
    const llm = fakeLlm([reply('from memory'), reply('answer')]);
    const r = await makeOracle(llm).ask({ turns: [{ role: 'user', content: 'q' }] });
    expect(r).toMatchObject({ variant: 'standard', text: 'answer' });
    expect(llm.requests[0]!.tools!.map((t) => ('function' in t ? t.function.name : ''))).toEqual([
      'search_rules',
      'read_rules',
    ]);
    expect(llm.requests[0]!.messages[0]!.content).toContain('Always start with the player rules');
  });

  it('offers read_guide and lists the guide topics in guide mode', async () => {
    const guideConfig = loadConfig({
      OPENAI_API_KEY: 'k',
      LLM_MODEL: 'm',
      LLM_PLAN_STEP: 'false',
      LLM_REVIEW_STEP: 'false',
      LLM_LOOKUP_MODE: 'guide',
    });
    const guide = new GuideStore('test/fixtures/code-guide.md', silentLogger);
    await guide.prepare(repo);
    const llm = fakeLlm([reply('answer')]);
    const oracle = new Oracle({
      config: guideConfig,
      repo,
      rules,
      guide,
      llm,
      logger: silentLogger,
    });
    const r = await oracle.ask({ turns: [{ role: 'user', content: 'q' }], variant: 'neworigins' });
    expect(r.lookupMode).toBe('guide');
    const names = llm.requests[0]!.tools!.map((t) => ('function' in t ? t.function.name : ''));
    expect(names).toEqual([
      'read_guide',
      'search_code',
      'read_file',
      'list_dir',
      'find_definition',
    ]);
    expect(llm.requests[0]!.messages[0]!.content).toContain('Guide topics: Items and data tables.');
  });

  it('falls back to grep lookup when guide mode has no guide', async () => {
    const guideConfig = loadConfig({
      OPENAI_API_KEY: 'k',
      LLM_MODEL: 'm',
      LLM_PLAN_STEP: 'false',
      LLM_REVIEW_STEP: 'false',
      LLM_LOOKUP_MODE: 'guide',
    });
    const llm = fakeLlm([reply('answer')]);
    const oracle = new Oracle({ config: guideConfig, repo, rules, llm, logger: silentLogger });
    const r = await oracle.ask({ turns: [{ role: 'user', content: 'q' }], variant: 'neworigins' });
    expect(r.lookupMode).toBe('grep');
    const names = llm.requests[0]!.tools!.map((t) => ('function' in t ? t.function.name : ''));
    expect(names).toEqual(['search_code', 'read_file', 'list_dir', 'find_definition']);
    expect(llm.requests[0]!.messages[0]!.content).toContain('Likely locations in the code');
  });

  it('offers code tools directly and passes the conversation when a variant has no rules', async () => {
    const llm = fakeLlm([reply('answer')]);
    const r = await makeOracle(llm).ask({
      turns: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
      variant: 'neworigins',
    });
    expect(r).toMatchObject({ text: 'answer', variant: 'neworigins', commit: 'abcdef1234567890' });
    const [system, ...rest] = llm.requests[0]!.messages;
    expect(system!.content).toContain('assume "neworigins"');
    expect(system!.content).toContain('commit abcdef1234');
    expect(system!.content).toContain('No player rules are available');
    expect(rest.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
    expect(llm.requests[0]!.tools).toHaveLength(4);
    expect(system!.content).not.toContain('Game abbreviations');
  });

  it('explains abbreviations in the question', async () => {
    const llm = fakeLlm([reply('answer')]);
    await makeOracle(llm).ask({
      turns: [{ role: 'user', content: 'Is PARM good?' }],
      variant: 'neworigins',
    });
    expect(llm.requests[0]!.messages[0]!.content).toContain('PARM = item "plate armor"');
  });
});
