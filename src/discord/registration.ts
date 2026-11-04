import { REST, Routes } from 'discord.js';
import type { DiscordConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { buildCommands } from './commands.js';

/**
 * Pushes the slash command definitions to Discord: to one server when
 * DISCORD_GUILD_ID is set (instant), otherwise globally. Replaces whatever
 * was registered before, so disabled commands disappear. Admin-only commands
 * are registered for server administrators only.
 */
export async function registerCommands(
  discord: DiscordConfig,
  variants: string[],
  logger: Logger,
): Promise<void> {
  const commands = buildCommands(variants, discord.commands, discord.adminCommands);
  const rest = new REST().setToken(discord.token);
  const route = discord.guildId
    ? Routes.applicationGuildCommands(discord.clientId, discord.guildId)
    : Routes.applicationCommands(discord.clientId);
  await rest.put(route, { body: commands });
  logger.info(
    {
      commands: commands.filter((c) => c.default_member_permissions == null).map((c) => c.name),
      adminCommands: commands
        .filter((c) => c.default_member_permissions != null)
        .map((c) => c.name),
      scope: discord.guildId ? `guild ${discord.guildId}` : 'global',
    },
    'Registered slash commands',
  );
}
