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

const envSchema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,
  ALLOWED_CHANNEL_IDS: commaList,

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
  LLM_TOOL_OUTPUT_BUDGET: withDefault(z.coerce.number().int().positive(), 60000),
  LLM_MAX_CONCURRENT: withDefault(z.coerce.number().int().positive(), 1),
  LLM_PLAN_STEP: withDefault(z.stringbool(), 'true'),
  LLM_REVIEW_STEP: withDefault(z.stringbool(), 'true'),

  GAME_REPO_URL: withDefault(z.string().min(1), 'https://github.com/Atlantis-PBEM/Atlantis.git'),
  GAME_REPO_BRANCH: optionalString,
  GAME_REPO_DIR: withDefault(z.string().min(1), './data/game-repo'),
  GAME_REPO_SYNC_INTERVAL_MINUTES: withDefault(z.coerce.number().min(0), 360),
  DEFAULT_GAME_VARIANT: withDefault(z.string().min(1), 'standard'),
  RULES_DIR: withDefault(z.string().min(1), './data/rules'),
  RULES_BUILD: withDefault(z.stringbool(), 'true'),

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
  /** Total characters of tool output per question. */
  toolOutputBudget: number;
  maxConcurrent: number;
  /** Ask for a research plan before the tool loop. */
  planStep: boolean;
  /** Review the draft answer against the research before sending it. */
  reviewStep: boolean;
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

export interface DiscordConfig {
  token: string;
  clientId: string;
  guildId: string | undefined;
  allowedChannelIds: string[];
  rateLimitPerUserPerMinute: number;
}

export interface Config {
  llm: LlmConfig;
  repo: RepoConfig;
  rules: RulesConfig;
  defaultVariant: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  discord: Partial<DiscordConfig> &
    Pick<DiscordConfig, 'allowedChannelIds' | 'rateLimitPerUserPerMinute'>;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
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
      toolOutputBudget: e.LLM_TOOL_OUTPUT_BUDGET,
      maxConcurrent: e.LLM_MAX_CONCURRENT,
      planStep: e.LLM_PLAN_STEP,
      reviewStep: e.LLM_REVIEW_STEP,
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
    defaultVariant: e.DEFAULT_GAME_VARIANT,
    logLevel: e.LOG_LEVEL,
    discord: {
      token: e.DISCORD_TOKEN,
      clientId: e.DISCORD_CLIENT_ID,
      guildId: e.DISCORD_GUILD_ID,
      allowedChannelIds: e.ALLOWED_CHANNEL_IDS,
      rateLimitPerUserPerMinute: e.RATE_LIMIT_PER_USER_PER_MINUTE,
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
