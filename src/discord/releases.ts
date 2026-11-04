import {
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  type Client,
  type SendableChannels,
} from 'discord.js';
import type { HudConfig } from '../config.js';
import type { Release } from '../github/client.js';
import type { Announcer } from '../github/releases.js';
import { formatRelease } from './format.js';

/** Errors that no retry will fix: the message or channel is gone, or the bot may not touch it. */
const PERMANENT = new Set<number>([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
  RESTJSONErrorCodes.CannotEditMessageAuthoredByAnotherUser,
]);

/**
 * Posts a new release in the announcement channel, formatted like
 * /latest-release, and edits that message when the release changes.
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
  const payload = (release: Release) => ({
    content: formatRelease(release, hud),
    allowedMentions: { parse: [] },
    flags: MessageFlags.SuppressEmbeds as const,
  });
  return {
    async post(release) {
      return (await (await channel()).send(payload(release))).id;
    },
    async revise(messageId, release) {
      try {
        // Editing by ID needs no Read Message History, unlike fetching the message first.
        await (await channel()).messages.edit(messageId, payload(release));
        return true;
      } catch (err) {
        if (
          err instanceof DiscordAPIError &&
          typeof err.code === 'number' &&
          PERMANENT.has(err.code)
        ) {
          return false;
        }
        throw err;
      }
    },
  };
}
