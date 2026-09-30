import 'dotenv/config';
import { Events } from 'discord.js';
import { loadConfig, requireDiscord } from './config.js';
import { createDiscordClient } from './discord/client.js';
import { registerHandlers } from './discord/handlers.js';
import { createLlmClient } from './llm/client.js';
import { createLogger } from './logger.js';
import { Oracle } from './oracle.js';
import { GameRepo } from './repo/sync.js';
import { RulesStore } from './rules/store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const discord = requireDiscord(config);
  const logger = createLogger(config.logLevel);

  const repo = new GameRepo(config.repo, logger);
  await repo.sync();
  // The first build of the rules can take a few minutes; later ones run after each sync.
  const rules = new RulesStore(config.rules, logger);
  await rules.prepare(repo);
  const stopSync = repo.startPeriodicSync(() => rules.prepare(repo));

  const oracle = new Oracle({ config, repo, rules, llm: createLlmClient(config.llm), logger });
  const client = createDiscordClient();
  registerHandlers(client, { config, discord, oracle, repo, logger });

  client.once(Events.ClientReady, (c) => {
    logger.info(
      { user: c.user.tag, guilds: c.guilds.cache.size, model: config.llm.model },
      'Discord bot ready',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopSync();
    void client.destroy().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(discord.token);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
