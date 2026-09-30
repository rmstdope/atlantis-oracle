import { Client, GatewayIntentBits } from 'discord.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Privileged: needed to read follow-up questions in answer threads.
      GatewayIntentBits.MessageContent,
    ],
    // Never ping anyone from generated text, whatever the model writes.
    allowedMentions: { parse: [] },
  });
}
