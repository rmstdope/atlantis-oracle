import {
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  type Client,
  type SendableChannels,
} from 'discord.js';
import type { HudConfig } from '../config.js';
import type { Announcer } from '../github/releases.js';
import { formatRelease } from './format.js';

/**
 * Posts a new release in the announcement channel, formatted like
 * /latest-release, and edits that message when the release notes change.
 */
export function createReleaseAnnouncer(
  client: Client,
  hud: HudConfig,
  channelId: string,
): Announcer {
  const channel = async (): Promise<SendableChannels> => {
    const c = await client.channels.fetch(channelId);
    if (!c?.isSendable()) throw new Error(`Cannot post in channel ${channelId}`);
    return c;
  };
  return {
    async post(release) {
      const message = await (
        await channel()
      ).send({
        content: formatRelease(release, hud),
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
      return message.id;
    },
    async revise(messageId, release) {
      try {
        const message = await (await channel()).messages.fetch(messageId);
        await message.edit({
          content: formatRelease(release, hud),
          allowedMentions: { parse: [] },
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (err) {
        // A deleted announcement stays deleted; anything else is retried.
        if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage)
          return;
        throw err;
      }
    },
  };
}
