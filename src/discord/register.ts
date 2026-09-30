import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadConfig, requireDiscord } from '../config.js';
import { createLogger } from '../logger.js';
import { GameRepo } from '../repo/sync.js';
import { buildCommands } from './commands.js';

/** `npm run register-commands`: pushes slash command definitions to Discord. */
async function main(): Promise<void> {
  const config = loadConfig();
  const discord = requireDiscord(config);
  const logger = createLogger(config.logLevel);

  const repo = new GameRepo(config.repo, logger);
  await repo.sync();
  const commands = buildCommands(repo.variants);

  const rest = new REST().setToken(discord.token);
  const route = discord.guildId
    ? Routes.applicationGuildCommands(discord.clientId, discord.guildId)
    : Routes.applicationCommands(discord.clientId);
  await rest.put(route, { body: commands });
  logger.info(
    {
      commands: commands.map((c) => c.name),
      scope: discord.guildId ? `guild ${discord.guildId}` : 'global',
    },
    'Registered slash commands',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
