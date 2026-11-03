import 'dotenv/config';
import { Events, Status } from 'discord.js';
import { loadConfig, requireDiscord } from './config.js';
import { createAnomalyDelivery } from './discord/anomalies.js';
import { createReleaseAnnouncer } from './discord/releases.js';
import { createDiscordClient } from './discord/client.js';
import { registerHandlers } from './discord/handlers.js';
import { registerCommands } from './discord/registration.js';
import { GithubClient } from './github/client.js';
import { ReleaseWatcher } from './github/releases.js';
import { AnomalyStore } from './github/store.js';
import { AnomalyTracker } from './github/tracker.js';
import { GuideStore } from './guide/store.js';
import { startHeartbeat } from './heartbeat.js';
import { createLlmClient } from './llm/client.js';
import { createLogger } from './logger.js';
import { Oracle } from './oracle.js';
import { GameRepo } from './repo/sync.js';
import { RulesStore } from './rules/store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const discord = requireDiscord(config);
  const logger = createLogger(config.logLevel);

  // The first start can spend many minutes cloning and building; stop promptly if asked.
  const stopEarly = (signal: string) => {
    logger.info({ signal }, 'Stopped during startup');
    process.exit(0);
  };
  process.once('SIGINT', stopEarly);
  process.once('SIGTERM', stopEarly);

  const repo = new GameRepo(config.repo, logger);
  await repo.sync();
  // The first build of the rules can take a few minutes; later ones run after each sync.
  const rules = new RulesStore(config.rules, logger);
  await rules.prepare(repo);
  const guide = new GuideStore(config.guide.path, logger);
  await guide.prepare(repo);
  if (discord.registerOnStart) await registerCommands(discord, repo.variants, logger);
  const stopSync = repo.startPeriodicSync(async () => {
    await rules.prepare(repo);
    await guide.prepare(repo);
  });

  const oracle = new Oracle({
    config,
    repo,
    rules,
    guide,
    llm: createLlmClient(config.llm),
    logger,
  });
  const gh = config.github;
  // Without a token, only public data (releases) can be read.
  const github = new GithubClient(gh?.token, config.hud.repo);
  // Tracking keeps following filed issues even if /report-bug and /wish are later disabled.
  const anomalies =
    gh && gh.pollIntervalMinutes > 0
      ? new AnomalyTracker(await AnomalyStore.load(gh.storePath), github, gh, logger)
      : undefined;

  const releases = new ReleaseWatcher(github, config.hud.statePath, logger);

  const client = createDiscordClient();
  registerHandlers(client, { config, discord, oracle, repo, logger, github, anomalies, releases });
  let stopTracking = () => {};
  let stopReleases = () => {};
  // Healthy while the gateway connection is up; discord.js reconnects by itself.
  const stopHeartbeat = await startHeartbeat(() => client.ws.status === Status.Ready);

  client.once(Events.ClientReady, (c) => {
    logger.info(
      { user: c.user.tag, guilds: c.guilds.cache.size, model: config.llm.model },
      'Discord bot ready',
    );
    if (anomalies && gh) {
      stopTracking = anomalies.start(gh.pollIntervalMinutes, createAnomalyDelivery(c));
    }
    const { announceChannelId, pollIntervalMinutes } = config.hud;
    if (announceChannelId && pollIntervalMinutes > 0) {
      stopReleases = releases.start(
        pollIntervalMinutes,
        createReleaseAnnouncer(c, config.hud, announceChannelId),
      );
    }
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopSync();
    stopTracking();
    stopReleases();
    void Promise.allSettled([stopHeartbeat(), client.destroy()]).finally(() => process.exit(0));
  };
  process.off('SIGINT', stopEarly);
  process.off('SIGTERM', stopEarly);
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(discord.token);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
