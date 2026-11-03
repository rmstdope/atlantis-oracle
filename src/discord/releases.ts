import { MessageFlags, type Client } from 'discord.js';
import type { HudConfig } from '../config.js';
import type { Announce } from '../github/releases.js';
import { formatRelease } from './format.js';

/** Posts a new release in the announcement channel, formatted like /latest-release. */
export function createReleaseAnnouncer(
  client: Client,
  hud: HudConfig,
  channelId: string,
): Announce {
  return async (release) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Cannot post in channel ${channelId}`);
    await channel.send({
      content: formatRelease(release, hud),
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    });
  };
}
