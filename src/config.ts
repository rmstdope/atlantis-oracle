import { z } from 'zod';

// Empty strings in .env files mean "unset".
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess((v) => (v === '' || v === undefined ? fallback : v), schema);

const commaList = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  z.array(z.string()),
);

/** Slash commands the bot offers; ENABLED_COMMANDS picks a subset. */
export const COMMAND_NAMES = [
  'ask',
  'collective-info',
  'report-bug',
  'wish',
  'anomalies',
  'latest-release',
] as const;
/** Commands that need GITHUB_TOKEN; `anomalies` also needs tracking switched on. */
const GITHUB_COMMANDS: readonly CommandName[] = ['report-bug', 'wish', 'anomalies'];
export type CommandName = (typeof COMMAND_NAMES)[number];

const envSchema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,
  ALLOWED_CHANNEL_IDS: commaList,
  // Unset = every command whose requirements are configured.
  ENABLED_COMMANDS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined),
    z
      .string()
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(COMMAND_NAMES)).min(1))
      .optional(),
  ),

  OPENAI_BASE_URL: withDefault(z.url(), 'https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required (any value for local servers)'),
  LLM_MODEL: z.string().min(1, 'LLM_MODEL is required'),
  LLM_TEMPERATURE: withDefault(z.coerce.number().min(0).max(2), 0.2),
  LLM_TOP_P: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().gt(0).max(1).optional(),
  ),
  LLM_MAX_TOOL_ITERATIONS: withDefault(z.coerce.number().int().min(1).max(50), 16),
  LLM_REQUEST_TIMEOUT_SECONDS: withDefault(z.coerce.number().int().positive(), 120),
  LLM_MAX_RETRIES: withDefault(z.coerce.number().int().min(0).max(10), 2),
  LLM_MAX_TOKENS: withDefault(z.coerce.number().int().positive(), 4096),
  LLM_THINKING: withDefault(z.enum(['on', 'off', 'final']), 'on'),
  LLM_FINAL_MAX_TOKENS: withDefault(z.coerce.number().int().positive(), 8192),
  LLM_TOOL_OUTPUT_BUDGET: withDefault(z.coerce.number().int().positive(), 60000),
  LLM_MAX_CONCURRENT: withDefault(z.coerce.number().int().positive(), 1),
  LLM_PLAN_STEP: withDefault(z.stringbool(), 'true'),
  LLM_REVIEW_STEP: withDefault(z.stringbool(), 'true'),
  LLM_LOOKUP_MODE: withDefault(z.enum(['grep', 'guide']), 'grep'),

  GAME_REPO_URL: withDefault(z.string().min(1), 'https://github.com/Atlantis-PBEM/Atlantis.git'),
  GAME_REPO_BRANCH: optionalString,
  GAME_REPO_DIR: withDefault(z.string().min(1), './data/game-repo'),
  GAME_REPO_SYNC_INTERVAL_MINUTES: withDefault(z.coerce.number().min(0), 360),
  DEFAULT_GAME_VARIANT: withDefault(z.string().min(1), 'standard'),
  RULES_DIR: withDefault(z.string().min(1), './data/rules'),
  RULES_BUILD: withDefault(z.stringbool(), 'true'),
  CODE_GUIDE_PATH: withDefault(z.string().min(1), './guides/atlantis-code.md'),

  GITHUB_TOKEN: optionalString,
  HUD_SITE_URL: withDefault(z.url(), 'https://atlantis-hud.rmstdope.eu'),
  RELEASE_ANNOUNCE_CHANNEL_ID: optionalString,
  RELEASE_POLL_INTERVAL_MINUTES: withDefault(z.coerce.number().min(0), 15),
  RELEASE_STATE_PATH: withDefault(z.string().min(1), './data/latest-release.json'),
  GITHUB_ISSUES_REPO: withDefault(
    z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'GITHUB_ISSUES_REPO must look like owner/name'),
    'rmstdope/atlantis-hud',
  ),
  GITHUB_BUG_LABELS: commaList,
  GITHUB_WISH_LABELS: commaList,
  BUG_REPORTS_PER_USER_PER_HOUR: withDefault(z.coerce.number().int().positive(), 3),
  GITHUB_POLL_INTERVAL_MINUTES: withDefault(z.coerce.number().min(0), 15),
  GITHUB_TRACK_CLOSED_DAYS: withDefault(z.coerce.number().min(0), 14),
  ANOMALY_STORE_PATH: withDefault(z.string().min(1), './data/anomalies.json'),

  RATE_LIMIT_PER_USER_PER_MINUTE: withDefault(z.coerce.number().int().positive(), 3),
  LOG_LEVEL: withDefault(z.enum(['debug', 'info', 'warn', 'error']), 'info'),
});

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** Nucleus sampling; sent only when set. */
  topP: number | undefined;
  maxToolIterations: number;
  requestTimeoutMs: number;
  /** SDK retries per request (timeouts included). */
  maxRetries: number;
  /** Output cap per request (max_tokens). */
  maxTokens: number;
  /** Reasoning control via chat_template_kwargs; 'on' sends nothing. */
  thinking: 'on' | 'off' | 'final';
  /** Output cap for reasoning calls in 'final' mode. */
  finalMaxTokens: number;
  /** Total characters of tool output per question. */
  toolOutputBudget: number;
  maxConcurrent: number;
  /** Ask for a research plan before the tool loop. */
  planStep: boolean;
  /** Review the draft answer against the research before sending it. */
  reviewStep: boolean;
  /**
   * How the model finds its way around the code: `grep` searches with
   * search_code, `guide` consults the code guide (read_guide) first.
   */
  lookupMode: 'grep' | 'guide';
}

export interface RepoConfig {
  url: string;
  branch: string | undefined;
  dir: string;
  syncIntervalMinutes: number;
}

export interface RulesConfig {
  /** Where built rules (HTML, Markdown) and the build workspace live. */
  dir: string;
  /** Build rules with the game's Makefile; otherwise use committed snapshots only. */
  build: boolean;
}

export interface GuideConfig {
  /** The code guide Markdown file; missing file = guide lookup unavailable. */
  path: string;
}

export interface GithubConfig {
  /** Token whose owner files the issues (needs Issues: write on `repo`). */
  token: string;
  /** `owner/name` of the repository that receives bug reports. */
  repo: string;
  /** Labels for /report-bug issues. */
  bugLabels: string[];
  /** Labels for /wish issues. */
  wishLabels: string[];
  reportsPerUserPerHour: number;
  /** How often reported issues are checked for updates; 0 = no tracking. */
  pollIntervalMinutes: number;
  /** Days a closed issue is still watched (it may be reopened). */
  trackClosedDays: number;
  /** JSON file with the tracked reports. */
  storePath: string;
}

/** The HUD whose releases /latest-release shows. */
export interface HudConfig {
  /** `owner/name` on GitHub (GITHUB_ISSUES_REPO). */
  repo: string;
  siteUrl: string;
  /** Channel that announces new releases; unset = no announcements. */
  announceChannelId: string | undefined;
  /** How often to look for a new release; 0 = never. */
  pollIntervalMinutes: number;
  /** JSON file remembering the last announced release. */
  statePath: string;
}

export interface DiscordConfig {
  token: string;
  clientId: string;
  guildId: string | undefined;
  allowedChannelIds: string[];
  rateLimitPerUserPerMinute: number;
  /** Slash commands to register and answer; thread follow-ups belong to `ask`. */
  commands: CommandName[];
}

export interface Config {
  llm: LlmConfig;
  repo: RepoConfig;
  rules: RulesConfig;
  guide: GuideConfig;
  hud: HudConfig;
  /** Bug reports to GitHub; undefined when GITHUB_TOKEN is unset. */
  github: GithubConfig | undefined;
  defaultVariant: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  discord: Partial<DiscordConfig> &
    Pick<DiscordConfig, 'allowedChannelIds' | 'rateLimitPerUserPerMinute' | 'commands'>;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  const tracking = e.GITHUB_TOKEN !== undefined && e.GITHUB_POLL_INTERVAL_MINUTES > 0;
  for (const c of e.ENABLED_COMMANDS ?? []) {
    if (GITHUB_COMMANDS.includes(c) && !e.GITHUB_TOKEN) {
      throw new ConfigError(`ENABLED_COMMANDS includes ${c}, but GITHUB_TOKEN is not set`);
    }
    if (c === 'anomalies' && !tracking) {
      throw new ConfigError(
        'ENABLED_COMMANDS includes anomalies, but GITHUB_POLL_INTERVAL_MINUTES is 0',
      );
    }
  }
  const commands =
    e.ENABLED_COMMANDS ??
    COMMAND_NAMES.filter((c) =>
      c === 'anomalies' ? tracking : !GITHUB_COMMANDS.includes(c) || e.GITHUB_TOKEN !== undefined,
    );
  return {
    llm: {
      baseURL: e.OPENAI_BASE_URL,
      apiKey: e.OPENAI_API_KEY,
      model: e.LLM_MODEL,
      temperature: e.LLM_TEMPERATURE,
      topP: e.LLM_TOP_P,
      maxToolIterations: e.LLM_MAX_TOOL_ITERATIONS,
      requestTimeoutMs: e.LLM_REQUEST_TIMEOUT_SECONDS * 1000,
      maxRetries: e.LLM_MAX_RETRIES,
      maxTokens: e.LLM_MAX_TOKENS,
      thinking: e.LLM_THINKING,
      finalMaxTokens: e.LLM_FINAL_MAX_TOKENS,
      toolOutputBudget: e.LLM_TOOL_OUTPUT_BUDGET,
      maxConcurrent: e.LLM_MAX_CONCURRENT,
      planStep: e.LLM_PLAN_STEP,
      reviewStep: e.LLM_REVIEW_STEP,
      lookupMode: e.LLM_LOOKUP_MODE,
    },
    repo: {
      url: e.GAME_REPO_URL,
      branch: e.GAME_REPO_BRANCH,
      dir: e.GAME_REPO_DIR,
      syncIntervalMinutes: e.GAME_REPO_SYNC_INTERVAL_MINUTES,
    },
    rules: {
      dir: e.RULES_DIR,
      build: e.RULES_BUILD,
    },
    guide: {
      path: e.CODE_GUIDE_PATH,
    },
    hud: {
      repo: e.GITHUB_ISSUES_REPO,
      siteUrl: e.HUD_SITE_URL,
      announceChannelId: e.RELEASE_ANNOUNCE_CHANNEL_ID,
      pollIntervalMinutes: e.RELEASE_POLL_INTERVAL_MINUTES,
      statePath: e.RELEASE_STATE_PATH,
    },
    github: e.GITHUB_TOKEN
      ? {
          token: e.GITHUB_TOKEN,
          repo: e.GITHUB_ISSUES_REPO,
          bugLabels: e.GITHUB_BUG_LABELS,
          wishLabels: e.GITHUB_WISH_LABELS,
          reportsPerUserPerHour: e.BUG_REPORTS_PER_USER_PER_HOUR,
          pollIntervalMinutes: e.GITHUB_POLL_INTERVAL_MINUTES,
          trackClosedDays: e.GITHUB_TRACK_CLOSED_DAYS,
          storePath: e.ANOMALY_STORE_PATH,
        }
      : undefined,
    defaultVariant: e.DEFAULT_GAME_VARIANT,
    logLevel: e.LOG_LEVEL,
    discord: {
      token: e.DISCORD_TOKEN,
      clientId: e.DISCORD_CLIENT_ID,
      guildId: e.DISCORD_GUILD_ID,
      allowedChannelIds: e.ALLOWED_CHANNEL_IDS,
      rateLimitPerUserPerMinute: e.RATE_LIMIT_PER_USER_PER_MINUTE,
      commands: [...new Set(commands)],
    },
  };
}

/** Narrows the Discord section; call from Discord entry points only. */
export function requireDiscord(config: Config): DiscordConfig {
  const { token, clientId } = config.discord;
  const missing = [!token && 'DISCORD_TOKEN', !clientId && 'DISCORD_CLIENT_ID'].filter(Boolean);
  if (!token || !clientId) {
    throw new ConfigError(`Missing required Discord configuration: ${missing.join(', ')}`);
  }
  return { ...config.discord, token, clientId, guildId: config.discord.guildId };
}
