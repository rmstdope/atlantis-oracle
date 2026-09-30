import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, requireDiscord } from '../src/config.js';

const minimal = { OPENAI_API_KEY: 'x', LLM_MODEL: 'm' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(minimal);
    expect(c.llm.baseURL).toBe('https://api.openai.com/v1');
    expect(c.llm.temperature).toBe(0.2);
    expect(c.llm.maxToolIterations).toBe(12);
    expect(c.llm.requestTimeoutMs).toBe(120_000);
    expect(c.llm.maxConcurrent).toBe(1);
    expect(c.repo.url).toBe('https://github.com/Atlantis-PBEM/Atlantis.git');
    expect(c.repo.branch).toBeUndefined();
    expect(c.repo.syncIntervalMinutes).toBe(360);
    expect(c.defaultVariant).toBe('standard');
    expect(c.discord.allowedChannelIds).toEqual([]);
    expect(c.discord.rateLimitPerUserPerMinute).toBe(3);
  });

  it('treats empty strings as unset', () => {
    const c = loadConfig({
      ...minimal,
      OPENAI_BASE_URL: '',
      GAME_REPO_BRANCH: '',
      LLM_TEMPERATURE: '',
    });
    expect(c.llm.baseURL).toBe('https://api.openai.com/v1');
    expect(c.repo.branch).toBeUndefined();
    expect(c.llm.temperature).toBe(0.2);
  });

  it('parses numbers and comma lists', () => {
    const c = loadConfig({
      ...minimal,
      LLM_TEMPERATURE: '0.7',
      GAME_REPO_SYNC_INTERVAL_MINUTES: '0',
      ALLOWED_CHANNEL_IDS: ' 1, 2 ,,3',
    });
    expect(c.llm.temperature).toBe(0.7);
    expect(c.repo.syncIntervalMinutes).toBe(0);
    expect(c.discord.allowedChannelIds).toEqual(['1', '2', '3']);
  });

  it('reports missing required values', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/LLM_MODEL/);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ ...minimal, LLM_TEMPERATURE: 'hot' })).toThrow(/LLM_TEMPERATURE/);
    expect(() => loadConfig({ ...minimal, OPENAI_BASE_URL: 'not a url' })).toThrow(
      /OPENAI_BASE_URL/,
    );
  });
});

describe('requireDiscord', () => {
  it('throws when the token is missing', () => {
    expect(() => requireDiscord(loadConfig(minimal))).toThrow(/DISCORD_TOKEN, DISCORD_CLIENT_ID/);
  });

  it('returns the narrowed config', () => {
    const d = requireDiscord(
      loadConfig({ ...minimal, DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c' }),
    );
    expect(d.token).toBe('t');
    expect(d.clientId).toBe('c');
  });
});
