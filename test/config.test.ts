import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, requireDiscord } from '../src/config.js';

const minimal = { OPENAI_API_KEY: 'x', LLM_MODEL: 'm' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(minimal);
    expect(c.llm.baseURL).toBe('https://api.openai.com/v1');
    expect(c.llm.temperature).toBe(0.2);
    expect(c.llm.maxToolIterations).toBe(16);
    expect(c.rules).toEqual({ dir: './data/rules', build: true });
    expect(c.llm.requestTimeoutMs).toBe(120_000);
    expect(c.llm.maxConcurrent).toBe(1);
    expect(c.llm.planStep).toBe(true);
    expect(c.llm.topP).toBeUndefined();
    expect(c.llm.maxRetries).toBe(2);
    expect(c.llm.maxTokens).toBe(4096);
    expect(c.llm.thinking).toBe('on');
    expect(c.llm.finalMaxTokens).toBe(8192);
    expect(c.llm.toolOutputBudget).toBe(60000);
    expect(c.llm.reviewStep).toBe(true);
    expect(c.llm.topicCheck).toBe(true);
    expect(c.repo.url).toBe('https://github.com/Atlantis-PBEM/Atlantis.git');
    expect(c.repo.branch).toBeUndefined();
    expect(c.repo.syncIntervalMinutes).toBe(360);
    expect(c.defaultVariant).toBe('standard');
    expect(c.discord.allowedChannelIds).toEqual([]);
    expect(c.discord.rateLimitPerUserPerMinute).toBe(3);
    expect(c.discord.registerOnStart).toBe(false);
    expect(c.github).toBeUndefined();
    expect(c.discord.commands).toEqual([
      'access-collective-hive-mind',
      'collective-info',
      'latest-release',
    ]);
    expect(c.hud).toEqual({
      repo: 'rmstdope/atlantis-hud',
      siteUrl: 'https://atlantis-hud.rmstdope.eu',
      announceChannelId: undefined,
      pollIntervalMinutes: 15,
      statePath: './data/latest-release.json',
    });
  });

  it('parses ENABLED_COMMANDS', () => {
    expect(loadConfig({ ...minimal, GITHUB_TOKEN: 't' }).discord.commands).toEqual([
      'access-collective-hive-mind',
      'collective-info',
      'report-bug',
      'wish',
      'anomalies',
      'latest-release',
    ]);
    // Without tracking there is nothing for /anomalies to list.
    expect(
      loadConfig({ ...minimal, GITHUB_TOKEN: 't', GITHUB_POLL_INTERVAL_MINUTES: '0' }).discord
        .commands,
    ).toEqual([
      'access-collective-hive-mind',
      'collective-info',
      'report-bug',
      'wish',
      'latest-release',
    ]);
    expect(loadConfig({ ...minimal, ENABLED_COMMANDS: '' }).discord.commands).toEqual([
      'access-collective-hive-mind',
      'collective-info',
      'latest-release',
    ]);
    const c = loadConfig({
      ...minimal,
      GITHUB_TOKEN: 't',
      ENABLED_COMMANDS: ' report-bug, collective-info,report-bug ',
    });
    expect(c.discord.commands).toEqual(['report-bug', 'collective-info']);
    expect(() => loadConfig({ ...minimal, ENABLED_COMMANDS: 'ask,nope' })).toThrow(ConfigError);
    // `ask` is the old name of the ask command.
    expect(loadConfig({ ...minimal, ENABLED_COMMANDS: 'ask' }).discord.commands).toEqual([
      'access-collective-hive-mind',
    ]);
    expect(() => loadConfig({ ...minimal, ENABLED_COMMANDS: ',' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, ENABLED_COMMANDS: 'report-bug' })).toThrow(
      /GITHUB_TOKEN/,
    );
    expect(() => loadConfig({ ...minimal, ENABLED_COMMANDS: 'wish' })).toThrow(/GITHUB_TOKEN/);
    expect(() =>
      loadConfig({
        ...minimal,
        GITHUB_TOKEN: 't',
        GITHUB_POLL_INTERVAL_MINUTES: '0',
        ENABLED_COMMANDS: 'anomalies',
      }),
    ).toThrow(/GITHUB_POLL_INTERVAL_MINUTES/);
  });

  it('gives ADMIN_USER_ID the available commands that ENABLED_COMMANDS leaves out', () => {
    const c = loadConfig({
      ...minimal,
      GITHUB_TOKEN: 't',
      GITHUB_POLL_INTERVAL_MINUTES: '0',
      // `ask` is the command's old name.
      ENABLED_COMMANDS: 'ask,collective-info',
      ADMIN_USER_ID: ' 123456789012345678 ',
    });
    expect(c.discord.adminUserId).toBe('123456789012345678');
    // anomalies needs tracking, so not even the admin gets it.
    expect(c.discord.adminCommands).toEqual(['report-bug', 'wish', 'latest-release']);
    expect(
      loadConfig({ ...minimal, ENABLED_COMMANDS: 'access-collective-hive-mind' }).discord
        .adminCommands,
    ).toEqual([]);
    expect(loadConfig({ ...minimal, ADMIN_USER_ID: '' }).discord.adminUserId).toBeUndefined();
    expect(() => loadConfig({ ...minimal, ADMIN_USER_ID: '@henrik' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, ADMIN_USER_ID: '1234' })).toThrow(ConfigError);
  });

  it('enables GitHub bug reports only with a token', () => {
    expect(loadConfig({ ...minimal, GITHUB_ISSUES_REPO: 'o/r' }).github).toBeUndefined();
    expect(loadConfig({ ...minimal, GITHUB_TOKEN: 't' }).github?.repo).toBe(
      'rmstdope/atlantis-hud',
    );
    const c = loadConfig({
      ...minimal,
      GITHUB_TOKEN: 't',
      GITHUB_ISSUES_REPO: 'owner/repo.name',
      GITHUB_BUG_LABELS: 'bug, discord',
      GITHUB_WISH_LABELS: 'enhancement',
    });
    expect(c.github).toEqual({
      token: 't',
      repo: 'owner/repo.name',
      bugLabels: ['bug', 'discord'],
      wishLabels: ['enhancement'],
      reportsPerUserPerHour: 3,
      pollIntervalMinutes: 15,
      trackClosedDays: 14,
      storePath: './data/anomalies.json',
    });
    expect(() => loadConfig({ ...minimal, GITHUB_ISSUES_REPO: 'https://github.com/o/r' })).toThrow(
      ConfigError,
    );
  });

  it('registers commands at start when asked', () => {
    expect(
      loadConfig({ ...minimal, DISCORD_REGISTER_COMMANDS: 'true' }).discord.registerOnStart,
    ).toBe(true);
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
      RULES_BUILD: 'false',
      LLM_TOP_P: '0.95',
      LLM_MAX_RETRIES: '0',
    });
    expect(c.llm.topP).toBe(0.95);
    expect(c.llm.maxRetries).toBe(0);
    expect(c.rules.build).toBe(false);
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
