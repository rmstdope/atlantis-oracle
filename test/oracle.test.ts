import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Oracle } from '../src/oracle.js';
import type { GameRepo } from '../src/repo/sync.js';
import { fakeLlm, reply } from './helpers/fakeLlm.js';
import { FIXTURE_REPO, silentLogger } from './helpers/fixture.js';

const config = loadConfig({
  OPENAI_API_KEY: 'k',
  LLM_MODEL: 'm',
  DEFAULT_GAME_VARIANT: 'standard',
});
const repo = {
  dir: FIXTURE_REPO,
  commit: 'abcdef1234567890',
  variants: ['neworigins', 'standard'],
} as GameRepo;

describe('Oracle', () => {
  it('resolves variants case-insensitively with a default fallback', () => {
    const oracle = new Oracle(config, repo, fakeLlm([]), silentLogger);
    expect(oracle.resolveVariant('NewOrigins')).toBe('neworigins');
    expect(oracle.resolveVariant('bogus')).toBe('standard');
    expect(oracle.resolveVariant(undefined)).toBe('standard');
  });

  it('builds the system prompt and passes the conversation', async () => {
    const llm = fakeLlm([reply('answer')]);
    const oracle = new Oracle(config, repo, llm, silentLogger);
    const r = await oracle.ask({
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
    expect(system!.content).toContain('Variants in this repository: neworigins, standard');
    expect(rest.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
  });
});
