import type { ChatTurn } from '../oracle.js';
import { isOffTopicReply, parseQuestion, STATUS_PREFIXES } from './format.js';

/** The parts of a Discord message the history needs; keeps this module testable. */
export interface HistoryMessage {
  id?: string;
  /** The message this one replies to (Discord's message reference). */
  replyToId?: string;
  authorId: string;
  content: string;
  createdTimestamp: number;
}

const MAX_TURN_CHARS = 2000;
/** Messages of the conversation (asker and bot) kept as context. */
export const HISTORY_LIMIT = 20;
/**
 * Thread messages fetched to find them: other players may talk in the thread,
 * and their messages are dropped, so fetch more than are kept (100 is
 * Discord's maximum per request).
 */
export const HISTORY_FETCH_LIMIT = 100;

function cleanBotMessage(content: string): string {
  // Progress messages from format.progressMessage are not part of the conversation.
  if (STATUS_PREFIXES.some((p) => content.startsWith(p))) return '';
  return content
    .split('\n')
    .filter((l) => !l.startsWith('-# '))
    .join('\n')
    .trim();
}

/**
 * Builds conversation turns from a bot-owned thread: the starter message (the
 * original question), then thread messages oldest first. Consecutive messages
 * from the same side are merged (long answers are split across messages).
 * With `askerId`, other players' messages are left out: they can talk in the
 * thread, but they can't steer the answers to someone else's question.
 * A message the topic check rejected is left out with its rejection, and the
 * last HISTORY_LIMIT messages of what remains are used.
 */
export function buildTurns(
  botId: string,
  starter: HistoryMessage | undefined,
  messages: HistoryMessage[],
  askerId?: string,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const push = (role: ChatTurn['role'], content: string) => {
    if (!content) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role, content });
  };

  if (starter) {
    const question = starter.authorId === botId ? parseQuestion(starter.content) : starter.content;
    if (question) push('user', question);
  }
  // A rejection replies to the message it rejected; both leave the history.
  const offTopic = (m: HistoryMessage) => m.authorId === botId && isOffTopicReply(m.content);
  const rejected = new Set(messages.filter(offTopic).map((m) => m.replyToId));
  const kept = [...messages]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .filter(
      (m) =>
        !offTopic(m) &&
        !(m.id !== undefined && rejected.has(m.id)) &&
        (m.authorId === botId || !askerId || m.authorId === askerId),
    );
  for (const m of kept.slice(-HISTORY_LIMIT)) {
    if (m.authorId === botId) push('assistant', cleanBotMessage(m.content));
    else push('user', m.content.trim());
  }
  for (const t of turns) {
    if (t.content.length > MAX_TURN_CHARS) t.content = `${t.content.slice(0, MAX_TURN_CHARS)}…`;
  }
  // The model must see a user turn last; drop trailing bot messages (e.g. errors).
  while (turns.at(-1)?.role === 'assistant') turns.pop();
  return turns;
}
