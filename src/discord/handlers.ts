import {
  ChannelType,
  Events,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type SendableChannels,
  type ThreadChannel,
} from 'discord.js';
import type { Config, DiscordConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ChatTurn, Oracle } from '../oracle.js';
import type { GameRepo } from '../repo/sync.js';
import { ASK, INFO } from './commands.js';
import {
  describeToolCall,
  footer,
  formatQuestion,
  progressMessage,
  splitMessage,
  threadName,
  variantFromThreadName,
} from './format.js';
import { buildTurns, HISTORY_LIMIT, type HistoryMessage } from './history.js';
import { RateLimiter } from './rateLimit.js';

const NO_MENTIONS = { parse: [] };
const TYPING_INTERVAL_MS = 8_000;
/** Minimum time between edits of the progress message (Discord rate-limits edits). */
const PROGRESS_INTERVAL_MS = 3_000;
const ERROR_REPLY = 'Sorry, something went wrong while answering. Please try again later.';

export interface HandlerDeps {
  config: Config;
  discord: DiscordConfig;
  oracle: Oracle;
  repo: GameRepo;
  logger: Logger;
}

export function registerHandlers(client: Client, deps: HandlerDeps): void {
  const { discord, logger } = deps;
  const rateLimiter = new RateLimiter(discord.rateLimitPerUserPerMinute);

  const channelAllowed = (channelId: string | null, parentId?: string | null) =>
    discord.allowedChannelIds.length === 0 ||
    [channelId, parentId].some((id) => id != null && discord.allowedChannelIds.includes(id));

  const retryText = (ms: number) =>
    `You're asking questions quickly; try again in ${Math.ceil(ms / 1000)}s.`;

  /**
   * Runs the oracle and posts the answer to `channel`. While it works, a
   * progress message shows the research steps; it is removed afterwards.
   */
  async function answerInto(
    channel: SendableChannels | ThreadChannel,
    turns: ChatTurn[],
    variant: string | undefined,
    replyTo?: Message,
  ): Promise<void> {
    const started = Date.now();
    const steps: string[] = [];
    const render = () => progressMessage(steps, Date.now() - started, deps.oracle.queueLength);
    const progress = await channel
      .send({ content: render(), allowedMentions: NO_MENTIONS })
      .catch(() => undefined);

    // Throttled edits: at most one per interval, always showing the latest steps.
    let lastEdit = Date.now();
    let editTimer: NodeJS.Timeout | undefined;
    let done = false;
    const flush = () => {
      editTimer = undefined;
      lastEdit = Date.now();
      if (!done)
        void progress?.edit({ content: render(), allowedMentions: NO_MENTIONS }).catch(() => {});
    };
    const scheduleEdit = () => {
      if (editTimer || !progress) return;
      editTimer = setTimeout(flush, Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - lastEdit)));
    };
    // Keeps the elapsed time moving during long model calls.
    const heartbeat = setInterval(scheduleEdit, 15_000);

    await channel.sendTyping().catch(() => {});
    const typing = setInterval(() => void channel.sendTyping().catch(() => {}), TYPING_INTERVAL_MS);
    try {
      const result = await deps.oracle.ask({
        turns,
        variant,
        onToolCall: (name, args) => {
          steps.push(describeToolCall(name, args));
          scheduleEdit();
        },
      });
      const chunks = splitMessage(result.text);
      const last = chunks.length - 1;
      chunks[last] += `\n${footer({
        model: deps.config.llm.model,
        variant: result.variant,
        repoUrl: deps.config.repo.url,
        commit: result.commit,
      })}`;
      done = true;
      for (const [i, content] of chunks.entries()) {
        if (i === 0 && replyTo) await replyTo.reply({ content, allowedMentions: NO_MENTIONS });
        else await channel.send({ content, allowedMentions: NO_MENTIONS });
      }
      await progress?.delete().catch(() => {});
    } catch (err) {
      done = true;
      logger.error({ err }, 'Failed to answer question');
      const failed = progress
        ? progress.edit({ content: ERROR_REPLY, allowedMentions: NO_MENTIONS })
        : channel.send({ content: ERROR_REPLY, allowedMentions: NO_MENTIONS });
      await failed.catch(() => {});
    } finally {
      done = true;
      clearTimeout(editTimer);
      clearInterval(heartbeat);
      clearInterval(typing);
    }
  }

  async function handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
    const question = interaction.options.getString('question', true).trim();
    const channel = interaction.channel;

    if (!interaction.inGuild() || !channel) {
      await interaction.reply({
        content: 'Please ask in a server channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const parentId = channel.isThread() ? channel.parentId : null;
    if (!channelAllowed(interaction.channelId, parentId)) {
      await interaction.reply({
        content: "I don't answer questions in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const limit = rateLimiter.check(interaction.user.id);
    if (!limit.allowed) {
      await interaction.reply({
        content: retryText(limit.retryAfterMs),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const variant = deps.oracle.resolveVariant(
      interaction.options.getString('variant') ??
        (channel.isThread() ? variantFromThreadName(channel.name) : undefined),
    );
    await interaction.deferReply();
    const header = await interaction.editReply({
      content: formatQuestion(interaction.user.id, question),
      allowedMentions: NO_MENTIONS,
    });
    const turns: ChatTurn[] = [{ role: 'user', content: question }];

    // Already in a thread (or a channel without threads): answer right here.
    const canThread =
      channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
    if (!canThread) {
      if (!channel.isSendable()) return;
      await answerInto(channel, turns, variant, header);
      return;
    }

    let thread: ThreadChannel;
    try {
      thread = await header.startThread({
        name: threadName(question, variant),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
    } catch (err) {
      logger.warn({ err, channelId: channel.id }, 'Could not start a thread; answering inline');
      if (channel.isSendable()) await answerInto(channel, turns, variant, header);
      return;
    }
    await answerInto(thread, turns, variant);
  }

  async function handleInfo(interaction: ChatInputCommandInteraction): Promise<void> {
    const { repo, config } = deps;
    const synced = repo.lastSyncedAt
      ? `<t:${Math.floor(repo.lastSyncedAt.getTime() / 1000)}:R>`
      : 'never';
    const lines = [
      `**Repository:** <${config.repo.url}> (${repo.branch || 'default branch'})`,
      `**Commit:** \`${repo.commit.slice(0, 10)}\`, synced ${synced}`,
      `**Variants:** ${repo.variants.join(', ') || 'none detected'} (default: ${config.defaultVariant})`,
      `**Model:** \`${config.llm.model}\` via ${new URL(config.llm.baseURL).host}`,
      `**Queue:** ${deps.oracle.queueLength} waiting`,
    ];
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
  }

  async function handleThreadMessage(message: Message<true>, thread: ThreadChannel): Promise<void> {
    const botId = client.user!.id;
    const limit = rateLimiter.check(message.author.id);
    if (!limit.allowed) {
      await message.reply({ content: retryText(limit.retryAfterMs), allowedMentions: NO_MENTIONS });
      return;
    }

    const toHistory = (m: Message): HistoryMessage => ({
      authorId: m.author.id,
      content: m.content,
      createdTimestamp: m.createdTimestamp,
    });
    const [starter, recent] = await Promise.all([
      thread.fetchStarterMessage().catch(() => null),
      thread.messages.fetch({ limit: HISTORY_LIMIT }),
    ]);
    const turns = buildTurns(
      botId,
      starter ? toHistory(starter) : undefined,
      [...recent.values()].map(toHistory),
    );
    if (turns.at(-1)?.role !== 'user') return;
    await answerInto(thread, turns, variantFromThreadName(thread.name), message);
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === ASK) await handleAsk(interaction);
      else if (interaction.commandName === INFO) await handleInfo(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, 'Command failed');
      const reply = { content: ERROR_REPLY, flags: MessageFlags.Ephemeral as const };
      await (
        interaction.deferred || interaction.replied
          ? interaction.followUp(reply)
          : interaction.reply(reply)
      ).catch(() => {});
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // Only follow-ups in threads the bot started; @mentions come later.
    if (message.author.bot || !message.inGuild() || !message.channel.isThread()) return;
    const thread = message.channel;
    if (thread.ownerId !== client.user?.id) return;
    if (!channelAllowed(thread.id, thread.parentId)) return;
    if (!message.content.trim()) return;
    try {
      await handleThreadMessage(message, thread);
    } catch (err) {
      logger.error({ err, threadId: thread.id }, 'Follow-up failed');
    }
  });
}
