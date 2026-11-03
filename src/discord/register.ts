import 'dotenv/config';
import { loadConfig, requireDiscord } from '../config.js';
import { createLogger } from '../logger.js';
import { GameRepo } from '../repo/sync.js';
import { registerCommands } from './registration.js';

/** `npm run register-commands`: pushes slash command definitions to Discord. */
async function main(): Promise<void> {
  const config = loadConfig();
  const discord = requireDiscord(config);
  const logger = createLogger(config.logLevel);

  const repo = new GameRepo(config.repo, logger);
  await repo.sync();
  await registerCommands(discord, repo.variants, logger);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
