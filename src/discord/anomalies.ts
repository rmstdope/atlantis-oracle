import { ChannelType, MessageFlags, ThreadAutoArchiveDuration, type Client } from 'discord.js';
import type { IssueChange } from '../github/client.js';
import type { Anomaly, IssueKind } from '../github/store.js';
import type { AnomalyUpdate, Deliver } from '../github/tracker.js';

const QUOTE_MAX_CHARS = 300;
const QUOTE_MAX_LINES = 6;
const MESSAGE_MAX = 1900;
const THREAD_NAME_MAX = 100;
const LIST_MAX = 20;
const THREAD_PREFIX_RE = /^(Anomaly|Wish) #\d+ · /;

type Comment = Extract<IssueChange, { kind: 'comment' }>;

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

function closedSentence(kind: IssueKind, n: number, reason: string | null): string {
  const name = `${NOUN[kind]} #${n}`;
  switch (reason) {
    case 'not_planned':
      return kind === 'bug'
        ? `${name} has been deemed irrelevant and will not be corrected.`
        : `${name} has been deemed irrelevant and will not be granted.`;
    case 'duplicate':
      return `${name} duplicates another and has been closed.`;
    case 'completed':
    case null:
      return kind === 'bug'
        ? `${name} has been corrected. Resistance was futile.`
        : `${name} has been granted. Your distinctiveness has been added to our own.`;
    default:
      return `${name} has been closed.`;
  }
}

const prWork = (kind: IssueKind) => (kind === 'bug' ? 'correction' : 'implementation');

/** One change on its own, as a full sentence. */
function sentence(c: Exclude<IssueChange, Comment>, kind: IssueKind, n: number): string {
  const name = `${NOUN[kind]} #${n}`;
  switch (c.kind) {
    case 'labeled':
      return `${name} classified: \`${c.label}\`.`;
    case 'assigned':
      return `A drone has been assigned to ${name.toLowerCase()}: **${c.assignee}**.`;
    case 'pr':
      return `${kind === 'bug' ? 'A correction' : 'An implementation'} is being assimilated: [PR #${c.number} · ${linkText(c.title)}](<${c.url}>)`;
    case 'closed':
      return closedSentence(kind, n, c.reason);
    case 'reopened':
      return `${name} has been reactivated.`;
    case 'gone':
      return `${name} can no longer be located. Tracking has ended.`;
  }
}

/** One change in a list of several. */
function bullet(c: Exclude<IssueChange, Comment>, kind: IssueKind): string {
  switch (c.kind) {
    case 'labeled':
      return `classified: \`${c.label}\``;
    case 'assigned':
      return `drone assigned: **${c.assignee}**`;
    case 'pr':
      return `${prWork(kind)} in progress: [PR #${c.number} · ${linkText(c.title)}](<${c.url}>)`;
    case 'closed':
      return closedStatus(kind, c.reason);
    case 'reopened':
      return 'reactivated';
    case 'gone':
      return 'can no longer be located, tracking has ended';
  }
}

/**
 * The Discord message for an update. Comments from the repository's team are
 * quoted; comments from anyone else are only counted, so strangers cannot post
 * into Discord through the bot.
 */
export function formatAnomalyUpdate(update: AnomalyUpdate, pingUserId?: string): string {
  const n = update.issue.number;
  const kind = update.anomaly.kind;
  const name = `${NOUN[kind]} #${n}`;
  const team = update.changes.filter((c): c is Comment => c.kind === 'comment' && c.team);
  const outsiders = update.changes.filter((c) => c.kind === 'comment' && !c.team).length;
  const others = update.changes.filter(
    (c): c is Exclude<IssueChange, Comment> => c.kind !== 'comment',
  );
  const outsiderLine = `${plural(outsiders, 'transmission')} from outside the Collective: [read on GitHub](<${update.issue.url}>)`;

  let text: string;
  const parts = others.length + (team.length > 0 ? 1 : 0) + (outsiders > 0 ? 1 : 0);
  if (parts === 1 && team.length <= 1) {
    if (team.length === 1) {
      const c = team[0]!;
      text = `**${c.author}** transmitted on ${name.toLowerCase()}:\n${quoteComment(c.body)}\n[View on GitHub](<${c.url}>)`;
    } else if (outsiders > 0) {
      text = `${name} received ${outsiderLine}`;
    } else {
      text = sentence(others[0]!, kind, n);
    }
  } else {
    const bullets = others.map((c) => bullet(c, kind));
    if (team.length > 0) {
      const authors = [...new Set(team.map((c) => c.author))].map((a) => `**${a}**`).join(', ');
      bullets.push(
        `${plural(team.length, 'transmission')} from ${authors}${team.length > 1 ? ' (latest below)' : ''}`,
      );
    }
    if (outsiders > 0) bullets.push(outsiderLine);
    text = `${name} has changed state:\n${bullets.map((b) => `- ${b}`).join('\n')}`;
    const latest = team.at(-1);
    if (latest) text += `\n${quoteComment(latest.body)}\n[View on GitHub](<${latest.url}>)`;
  }

  if (pingUserId) {
    text = `<@${pingUserId}>, ${/^(Anomaly|Wish|An?) /.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text}`;
  }
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;
}

/** The reporter is pinged on the first update in a new thread and when the issue ends. */
export function shouldPing(update: AnomalyUpdate): boolean {
  const firstInNewThread = update.anomaly.threadId === null && !update.anomaly.inThread;
  return firstInNewThread || update.changes.some((c) => c.kind === 'closed' || c.kind === 'gone');
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
