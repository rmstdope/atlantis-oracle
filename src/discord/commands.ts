import {
  InteractionContextType,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { ASK_COMMAND, type CommandName, type DiscordConfig } from '../config.js';

export const ASK: CommandName = ASK_COMMAND;
export const INFO: CommandName = 'collective-info';
export const REPORT_BUG: CommandName = 'report-bug';
export const WISH: CommandName = 'wish';
export const ANOMALIES: CommandName = 'anomalies';
export const LATEST_RELEASE: CommandName = 'latest-release';
export const MAX_QUESTION_LENGTH = 1000;
/** Longest /report-bug or /wish text. */
export const MAX_ISSUE_TEXT_LENGTH = 2000;

/** Which commands a user may run: `released` for everyone, `adminOnly` for ADMIN_USER_ID. */
export function commandsFor(
  discord: Pick<DiscordConfig, 'commands' | 'adminCommands' | 'adminUserId'>,
  userId: string,
): { released: readonly CommandName[]; adminOnly: readonly CommandName[] } {
  return {
    released: discord.commands,
    adminOnly:
      discord.adminUserId !== undefined && userId === discord.adminUserId
        ? discord.adminCommands
        : [],
  };
}

/** Whether `userId` may run `name`. */
export function mayUse(
  discord: Pick<DiscordConfig, 'commands' | 'adminCommands' | 'adminUserId'>,
  userId: string,
  name: string,
): boolean {
  const { released, adminOnly } = commandsFor(discord, userId);
  return [...released, ...adminOnly].includes(name as CommandName);
}

/**
 * Definitions of the `enabled` slash commands (ENABLED_COMMANDS) and the
 * `adminOnly` ones (ADMIN_USER_ID). Admin-only commands require the
 * Administrator permission by default, so ordinary members don't see them;
 * the handler still answers them for the admin user only. Variant choices
 * come from the synced game repo.
 */
export function buildCommands(
  variants: string[],
  enabled: readonly CommandName[],
  adminOnly: readonly CommandName[] = [],
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const ask = new SlashCommandBuilder()
    .setName(ASK)
    .setDescription(
      'Query the Collective about Atlantis; the answer is assimilated from the game source',
    )
    .addStringOption((o) =>
      o
        .setName('question')
        .setDescription('Your question')
        .setRequired(true)
        .setMaxLength(MAX_QUESTION_LENGTH),
    )
    .addStringOption((o) => {
      o.setName('variant').setDescription('Game variant (default is set by the bot owner)');
      // Discord allows at most 25 choices; beyond that the option is free text.
      if (variants.length > 0 && variants.length <= 25) {
        o.addChoices(...variants.map((v) => ({ name: v, value: v })));
      }
      return o;
    });

  const info = new SlashCommandBuilder()
    .setName(INFO)
    .setDescription('Learn what The Collective is, its commands, and the source and model it uses');

  const reportBug = new SlashCommandBuilder()
    .setName(REPORT_BUG)
    .setDescription('Report an anomaly in The Collective (filed as a public GitHub issue)')
    .addStringOption((o) =>
      o
        .setName('description')
        .setDescription('Describe the anomaly. The first line becomes the issue title.')
        .setRequired(true)
        .setMaxLength(MAX_ISSUE_TEXT_LENGTH),
    );

  const wish = new SlashCommandBuilder()
    .setName(WISH)
    .setDescription('Wish for a feature or change (filed as a public GitHub issue)')
    .addStringOption((o) =>
      o
        .setName('description')
        .setDescription('What should be added or changed? The first line becomes the issue title.')
        .setRequired(true)
        .setMaxLength(MAX_ISSUE_TEXT_LENGTH),
    );

  const anomalies = new SlashCommandBuilder()
    .setName(ANOMALIES)
    .setDescription('List your bug reports and wishes and their status (only visible to you)');

  const latestRelease = new SlashCommandBuilder()
    .setName(LATEST_RELEASE)
    .setDescription(
      'Show the latest release of the HUD, with links and release notes (only visible to you)',
    );

  return [ask, info, reportBug, wish, anomalies, latestRelease].flatMap((c) => {
    const name = c.name as CommandName;
    if (enabled.includes(name)) return [c.toJSON()];
    if (adminOnly.includes(name)) {
      // Server channels only: default_member_permissions does not hide commands in DMs.
      return [c.setDefaultMemberPermissions(0).setContexts(InteractionContextType.Guild).toJSON()];
    }
    return [];
  });
}
