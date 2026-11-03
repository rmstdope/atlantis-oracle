import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { CommandName } from '../config.js';

export const ASK: CommandName = 'ask';
export const INFO: CommandName = 'collective-info';
export const REPORT_BUG: CommandName = 'report-bug';
export const WISH: CommandName = 'wish';
export const ANOMALIES: CommandName = 'anomalies';
export const LATEST_RELEASE: CommandName = 'latest-release';
export const MAX_QUESTION_LENGTH = 1000;
/** Longest /report-bug or /wish text. */
export const MAX_ISSUE_TEXT_LENGTH = 2000;

/**
 * Definitions of the `enabled` slash commands (ENABLED_COMMANDS). Variant
 * choices come from the synced game repo.
 */
export function buildCommands(
  variants: string[],
  enabled: readonly CommandName[],
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
    .setDescription('Show the game repository, commit and model The Collective uses');

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

  return [ask, info, reportBug, wish, anomalies, latestRelease]
    .filter((c) => enabled.includes(c.name as CommandName))
    .map((c) => c.toJSON());
}
