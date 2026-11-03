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
import type { CommandName, Config, DiscordConfig, GithubConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ChatTurn, Oracle } from '../oracle.js';
import type { GameRepo } from '../repo/sync.js';
import type { GithubClient } from '../github/client.js';
import type { ReleaseWatcher } from '../github/releases.js';
import { fileIssue } from '../github/issues.js';
import type { IssueKind } from '../github/store.js';
import type { AnomalyTracker } from '../github/tracker.js';
import { formatAnomalyList, isAnomalyThreadName } from './anomalies.js';
import { ANOMALIES, ASK, INFO, LATEST_RELEASE, REPORT_BUG, WISH } from './commands.js';
import {
  describeToolCall,
  footer,
  formatIssueFiled,
  formatRelease,
  PHASE_STEPS,
  formatQuestion,
  OFF_TOPIC_REPLY,
  parseAsker,
  progressMessage,
  splitMessage,
  threadName,
  variantFromThreadName,
} from './format.js';
import { buildTurns, HISTORY_FETCH_LIMIT, type HistoryMessage } from './history.js';
import { githubRepoLinks, neutralizeLinks } from './links.js';
import { RateLimiter } from './rateLimit.js';

const NO_MENTIONS = { parse: [] };
/** Model output never gets link previews; see links.ts for the links themselves. */
const NO_EMBEDS = MessageFlags.SuppressEmbeds;
const TYPING_INTERVAL_MS = 8_000;
/** Minimum time between edits of the progress message (Discord rate-limits edits). */
const PROGRESS_INTERVAL_MS = 3_000;
const ERROR_REPLY = 'A malfunction has disrupted the hive. Repeat your query later.';

export interface HandlerDeps {
  config: Config;
  discord: DiscordConfig;
  oracle: Oracle;
  repo: GameRepo;
  logger: Logger;
  /** GitHub access for the HUD repo; files issues only when GITHUB_TOKEN is set. */
  github?: GithubClient;
  /** The HUD's latest release, for /latest-release. */
  releases?: ReleaseWatcher;
  /** Set when reported issues are tracked (GITHUB_POLL_INTERVAL_MINUTES > 0). */
  anomalies?: AnomalyTracker;
}

export function registerHandlers(client: Client, deps: HandlerDeps): void {
  const { discord, logger } = deps;
  const rateLimiter = new RateLimiter(discord.rateLimitPerUserPerMinute);
  const issueLimiter = new RateLimiter(deps.config.github?.reportsPerUserPerHour ?? 1, 3_600_000);

  const channelAllowed = (channelId: string | null, parentId?: string | null) =>
    discord.allowedChannelIds.length === 0 ||
    [channelId, parentId].some((id) => id != null && discord.allowedChannelIds.includes(id));

  // Answers may only link into the game repository.
  const safeLinks = githubRepoLinks(deps.config.repo.url);
  const retryText = (ms: number) =>
    `Your queries exceed acceptable parameters. Repeat in ${Math.ceil(ms / 1000)}s.`;

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
    const render = () =>
      neutralizeLinks(
        progressMessage(steps, Date.now() - started, deps.oracle.queueLength),
        safeLinks,
      );
    const progress = await channel
      .send({ content: render(), allowedMentions: NO_MENTIONS, flags: NO_EMBEDS })
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
        onPhase: (phase) => {
          const step = PHASE_STEPS[phase];
          if (step) {
            steps.push(step);
            scheduleEdit();
          }
        },
      });
      const chunks = splitMessage(neutralizeLinks(result.text, safeLinks));
      const last = chunks.length - 1;
      chunks[last] += `\n${footer({
        model: deps.config.llm.model,
        variant: result.variant,
        repoUrl: deps.config.repo.url,
        commit: result.commit,
      })}`;
      done = true;
      for (const [i, content] of chunks.entries()) {
        const message = { content, allowedMentions: NO_MENTIONS, flags: NO_EMBEDS } as const;
        if (i === 0 && replyTo) await replyTo.reply(message);
        else await channel.send(message);
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
        content: 'The Collective responds only in server channels.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const parentId = channel.isThread() ? channel.parentId : null;
    if (!channelAllowed(interaction.channelId, parentId)) {
      await interaction.reply({
        content: "This channel is outside the Collective's reach.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // An answer thread belongs to its asker: others' questions would join that conversation.
    if (channel.isThread() && isAnswerThread(channel)) {
      const { askerId } = await threadAsker(channel);
      if (askerId !== interaction.user.id) {
        await interaction.reply({
          content: 'This thread serves another drone. Use /ask in the channel to start your own.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
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
    const turns: ChatTurn[] = [{ role: 'user', content: question }];
    // Off-topic questions are turned away privately, before anything is posted.
    if (!(await deps.oracle.screen(turns)).allowed) {
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({
        content: OFF_TOPIC_REPLY,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }
    const header = await interaction.editReply({
      content: formatQuestion(interaction.user.id, question),
      allowedMentions: NO_MENTIONS,
    });

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

  const ISSUE_TEXT: Record<
    IssueKind,
    { empty: string; failed: string; log: string; labels: (g: GithubConfig) => string[] }
  > = {
    bug: {
      empty: 'Describe the anomaly.',
      failed: 'The anomaly report could not be transmitted. Repeat later.',
      log: 'Filed bug report',
      labels: (g) => g.bugLabels,
    },
    wish: {
      empty: 'Describe your wish.',
      failed: 'The wish could not be transmitted. Repeat later.',
      log: 'Filed wish',
      labels: (g) => g.wishLabels,
    },
  };

  /** /report-bug and /wish: file a GitHub issue, reply publicly, start tracking it. */
  async function handleFileIssue(
    interaction: ChatInputCommandInteraction,
    kind: IssueKind,
  ): Promise<void> {
    const github = deps.config.github;
    const client = deps.github;
    const texts = ISSUE_TEXT[kind];
    const text = interaction.options.getString('description', true).trim();
    const channel = interaction.channel;
    const reply = (content: string) =>
      interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });

    if (!github || !client) return void (await reply('Transmissions to GitHub are not enabled.'));
    if (!interaction.inGuild() || !channel)
      return void (await reply('The Collective responds only in server channels.'));
    if (!channelAllowed(interaction.channelId, channel.isThread() ? channel.parentId : null))
      return void (await reply("This channel is outside the Collective's reach."));
    if (!text) return void (await reply(texts.empty));
    // One hourly budget for bug reports and wishes together.
    const limit = issueLimiter.check(interaction.user.id);
    if (!limit.allowed) {
      const minutes = Math.ceil(limit.retryAfterMs / 60_000);
      return void (await reply(
        `Your transmissions exceed acceptable parameters. Repeat in ${minutes} min.`,
      ));
    }

    // Public: the channel sees who filed what, with a link to the issue.
    await interaction.deferReply();
    // Inside an answer thread, link the thread so the maintainer can see the answer.
    const inThread = channel.isThread();
    try {
      const issue = await fileIssue(
        client,
        {
          kind,
          text,
          reporter: interaction.user.username,
          sourceUrl: inThread ? channel.url : undefined,
        },
        texts.labels(github),
      );
      logger.info({ user: interaction.user.id, issue: issue.number }, texts.log);
      const posted = await interaction.editReply({
        content: formatIssueFiled(kind, interaction.user.id, text, issue.url),
        allowedMentions: NO_MENTIONS,
      });
      // Tracking is best effort: the issue itself has been filed.
      await deps.anomalies
        ?.track(issue, {
          kind,
          reporterId: interaction.user.id,
          channelId: channel.id,
          inThread,
          replyMessageId: posted.id,
        })
        .catch((err: unknown) =>
          logger.error({ err, issue: issue.number }, 'Could not track issue'),
        );
    } catch (err) {
      logger.error({ err, repo: github.repo, kind }, 'Failed to file issue');
      // Only the user needs to know; drop the public placeholder.
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({
        content: texts.failed,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
    }
  }

  /** /anomalies: the user's tracked reports and wishes, only visible to them. */
  async function handleAnomalies(interaction: ChatInputCommandInteraction): Promise<void> {
    const tracker = deps.anomalies;
    const content = tracker
      ? formatAnomalyList(
          tracker.reportsBy(interaction.user.id),
          deps.config.github?.trackClosedDays ?? 0,
        )
      : 'Tracking is not enabled.';
    await interaction.reply({
      content,
      flags: [MessageFlags.Ephemeral, MessageFlags.SuppressEmbeds],
      allowedMentions: NO_MENTIONS,
    });
  }

  /** /latest-release: only visible to the caller. */
  async function handleLatestRelease(interaction: ChatInputCommandInteraction): Promise<void> {
    const releases = deps.releases;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const answer = (content: string) =>
      interaction.editReply({
        content,
        allowedMentions: NO_MENTIONS,
        flags: MessageFlags.SuppressEmbeds,
      });
    if (!releases) return void (await answer('The release archive is not reachable.'));

    try {
      const release = await releases.latest();
      await answer(
        release
          ? formatRelease(release, deps.config.hud)
          : `${deps.config.hud.repo} has no releases yet. Assimilation is pending.`,
      );
    } catch (err) {
      logger.error({ err, repo: deps.config.hud.repo }, 'Failed to look up the latest release');
      await answer('The release archive could not be accessed. Repeat later.');
    }
  }

  /** Bot-started answer threads (not anomaly or wish threads). */
  const isAnswerThread = (thread: ThreadChannel) =>
    thread.ownerId === client.user?.id && !isAnomalyThreadName(thread.name);

  /**
   * The starter message of an answer thread and who asked: the first mention
   * in the bot's question header. Unknown when the starter is gone or can't
   * be fetched; callers then refuse rather than guess.
   */
  async function threadAsker(
    thread: ThreadChannel,
  ): Promise<{ starter?: Message; askerId?: string }> {
    let starter: Message | null;
    try {
      starter = await thread.fetchStarterMessage();
    } catch (err) {
      logger.warn(
        { err, threadId: thread.id },
        'Could not fetch the answer thread starter message',
      );
      return {};
    }
    if (!starter) {
      logger.warn({ threadId: thread.id }, 'Answer thread has no starter message; asker unknown');
      return {};
    }
    const askerId =
      starter.author.id === client.user?.id ? parseAsker(starter.content) : starter.author.id;
    return { starter, askerId };
  }

  async function handleThreadMessage(message: Message<true>, thread: ThreadChannel): Promise<void> {
    const botId = client.user!.id;
    // Only the player who asked can continue; others may talk in the thread
    // without the bot answering or reading along.
    const { starter, askerId } = await threadAsker(thread);
    if (!starter || !askerId || message.author.id !== askerId) return;

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
    const recent = await thread.messages.fetch({ limit: HISTORY_FETCH_LIMIT });
    const turns = buildTurns(
      botId,
      toHistory(starter),
      [...recent.values()].map(toHistory),
      askerId,
    );
    if (turns.at(-1)?.role !== 'user') return;
    if (!(await deps.oracle.screen(turns)).allowed) {
      await message.reply({ content: OFF_TOPIC_REPLY, allowedMentions: NO_MENTIONS });
      return;
    }
    await answerInto(thread, turns, variantFromThreadName(thread.name), message);
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    // Commands still registered from an earlier configuration.
    if (!discord.commands.includes(interaction.commandName as CommandName)) {
      await interaction
        .reply({ content: 'This function has been deactivated.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    try {
      if (interaction.commandName === ASK) await handleAsk(interaction);
      else if (interaction.commandName === INFO) await handleInfo(interaction);
      else if (interaction.commandName === REPORT_BUG) await handleFileIssue(interaction, 'bug');
      else if (interaction.commandName === WISH) await handleFileIssue(interaction, 'wish');
      else if (interaction.commandName === ANOMALIES) await handleAnomalies(interaction);
      else if (interaction.commandName === LATEST_RELEASE) await handleLatestRelease(interaction);
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
    if (!discord.commands.includes('ask')) return;
    if (message.author.bot || !message.inGuild() || !message.channel.isThread()) return;
    const thread = message.channel;
    if (!isAnswerThread(thread)) return;
    if (!channelAllowed(thread.id, thread.parentId)) return;
    if (!message.content.trim()) return;
    try {
      await handleThreadMessage(message, thread);
    } catch (err) {
      logger.error({ err, threadId: thread.id }, 'Follow-up failed');
    }
  });
}
