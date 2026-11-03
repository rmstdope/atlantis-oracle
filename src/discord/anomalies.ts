import { ChannelType, MessageFlags, ThreadAutoArchiveDuration, type Client } from 'discord.js';
import type { Anomaly, IssueKind } from '../github/store.js';
import type { AnomalyUpdate, Deliver } from '../github/tracker.js';

const QUOTE_MAX_CHARS = 300;
const QUOTE_MAX_LINES = 6;
const MESSAGE_MAX = 1900;
const THREAD_NAME_MAX = 100;
const LIST_MAX = 20;
const THREAD_PREFIX_RE = /^(Anomaly|Wish) #\d+ · /;

/** How a bug report and a wish are named in messages. */
export const NOUN: Record<IssueKind, string> = { bug: 'Anomaly', wish: 'Wish' };

/** The issue title without the [Bug] / [Wish] prefix the bot gave it. */
const plainTitle = (title: string) => title.replace(/^\[(Bug|Wish)\]\s*/, '').trim();

/** Name of the thread that carries a report's or wish's updates. */
export function anomalyThreadName(kind: IssueKind, issue: number, title: string): string {
  const name = `${NOUN[kind]} #${issue} · ${plainTitle(title)}`;
  return name.length > THREAD_NAME_MAX ? `${name.slice(0, THREAD_NAME_MAX - 1)}…` : name;
}

/** Anomaly and wish threads are not answer threads: replies there never go to the LLM. */
export function isAnomalyThreadName(name: string): boolean {
  return THREAD_PREFIX_RE.test(name);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const linkText = (s: string) => s.replace(/[[\]]/g, '');

/** A GitHub comment as a short Discord quote. */
export function quoteComment(body: string): string {
  let text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lines = text.split('\n');
  let cut = lines.length > QUOTE_MAX_LINES;
  text = lines.slice(0, QUOTE_MAX_LINES).join('\n');
  if (text.length > QUOTE_MAX_CHARS) {
    text = text.slice(0, QUOTE_MAX_CHARS).trimEnd();
    cut = true;
  }
  if (cut) text += '…';
  return (text || '(empty)')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Short status word for a closed issue, e.g. "corrected" or "granted". */
function closedStatus(kind: IssueKind, reason: string | null): string {
  switch (reason) {
    case 'not_planned':
      return kind === 'bug' ? 'deemed irrelevant, will not be corrected' : 'will not be granted';
    case 'duplicate':
      return 'closed as a duplicate';
    case 'completed':
    case null:
      return kind === 'bug' ? 'corrected' : 'granted';
    default:
      return 'closed';
  }
}

/**
 * The Discord message for new comments: each comment by the repository's team
 * is quoted on its own; comments by anyone else are only counted, so strangers
 * cannot post into Discord through the bot. Comments that do not fit in one
 * message are summed up with a link.
 */
export function formatAnomalyUpdate(update: AnomalyUpdate, pingUserId?: string): string {
  const name = `${NOUN[update.anomaly.kind].toLowerCase()} #${update.issue.number}`;
  const team = update.comments.filter((c) => c.team);
  const outsiders = update.comments.length - team.length;
  const ping = pingUserId ? `<@${pingUserId}>, ` : '';
  const outsiderLine =
    outsiders > 0
      ? `${plural(outsiders, 'transmission')} from outside the Collective on ${name}: [read on GitHub](<${update.issue.url}>)`
      : '';

  const blocks: string[] = [];
  let length = ping.length + outsiderLine.length;
  for (const [i, c] of team.entries()) {
    const block = `**${c.author}** transmitted on ${name}:\n${quoteComment(c.body)}\n[View on GitHub](<${c.url}>)`;
    const more = `… and ${plural(team.length - i, 'more transmission')}: [read on GitHub](<${update.issue.url}>)`;
    if (length + block.length + 2 > MESSAGE_MAX - more.length - 2) {
      blocks.push(more);
      break;
    }
    blocks.push(block);
    length += block.length + 2;
  }
  if (outsiderLine) blocks.push(outsiderLine);
  return ping + blocks.join('\n\n');
}

/** The reporter is pinged on the first update, which starts the thread. */
export function shouldPing(update: AnomalyUpdate): boolean {
  return update.anomaly.threadId === null && !update.anomaly.inThread;
}

/** One line of /anomalies: link, title, status and labels. */
function listLine(a: Anomaly): string {
  const title = plainTitle(a.title);
  const shortTitle = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  const status = a.state === 'closed' ? closedStatus(a.kind, a.stateReason) : 'open';
  const labels = a.labels.map((l) => `\`${l}\``).join(' ');
  return `- [${NOUN[a.kind]} #${a.issue}](<${a.url}>) · ${linkText(shortTitle)} · **${status}**${labels ? ` · ${labels}` : ''}`;
}

/** The private /anomalies reply: the user's tracked reports and wishes, newest first. */
export function formatAnomalyList(anomalies: Anomaly[], trackClosedDays: number): string {
  if (anomalies.length === 0) {
    return 'The Collective holds no open anomalies or wishes from you.';
  }
  const newest = [...anomalies].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const lines = newest.slice(0, LIST_MAX).map(listLine);
  if (newest.length > LIST_MAX) lines.push(`-# … and ${newest.length - LIST_MAX} older`);
  return [
    'Your transmissions to the Collective:',
    ...lines,
    `-# Closed ones are listed for ${trackClosedDays} days.`,
  ].join('\n');
}

/**
 * Posts updates into a thread on the public reply with the issue link (created
 * at the first update). A report made inside a thread gets its updates there.
 */
export function createAnomalyDelivery(client: Client): Deliver {
  return async (update) => {
    const { anomaly } = update;
    const ping = shouldPing(update);
    const message = {
      content: formatAnomalyUpdate(update, ping ? anomaly.reporterId : undefined),
      // Only the reporter can be pinged, whatever the GitHub text contains.
      allowedMentions: { parse: [], users: ping ? [anomaly.reporterId] : [] },
      flags: MessageFlags.SuppressEmbeds as const,
    };

    if (anomaly.threadId) {
      const thread = await client.channels.fetch(anomaly.threadId).catch(() => null);
      if (thread?.isThread()) {
        await thread.send(message);
        return;
      }
      // The thread was deleted: start a new one below.
    }

    const channel = await client.channels.fetch(anomaly.channelId);
    if (!channel?.isSendable() || !('messages' in channel)) {
      throw new Error(`Cannot post in channel ${anomaly.channelId}`);
    }
    const reply = await channel.messages.fetch(anomaly.replyMessageId).catch(() => null);
    const canThread =
      !anomaly.inThread &&
      (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
    if (reply && canThread) {
      const thread =
        reply.thread ??
        (await reply.startThread({
          name: anomalyThreadName(anomaly.kind, update.issue.number, anomaly.title),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        }));
      await thread.send(message);
      return { threadId: thread.id };
    }
    if (reply) await reply.reply(message);
    else await channel.send(message);
  };
}
