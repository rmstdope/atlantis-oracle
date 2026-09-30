import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export const ASK = 'ask';
export const INFO = 'oracle-info';
export const MAX_QUESTION_LENGTH = 1000;

/** Slash command definitions. Variant choices come from the synced game repo. */
export function buildCommands(
  variants: string[],
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const ask = new SlashCommandBuilder()
    .setName(ASK)
    .setDescription('Ask a question about Atlantis; the answer is researched in the game source')
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
    .setDescription('Show the game repository, commit and model the oracle uses');

  return [ask.toJSON(), info.toJSON()];
}
