import type { ChatTurn } from '../oracle.js';
import { parseQuestion } from './format.js';

/** The parts of a Discord message the history needs; keeps this module testable. */
export interface HistoryMessage {
  authorId: string;
  content: string;
  createdTimestamp: number;
}

const MAX_TURN_CHARS = 2000;
export const HISTORY_LIMIT = 20;

function cleanBotMessage(content: string): string {
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
 */
export function buildTurns(
  botId: string,
  starter: HistoryMessage | undefined,
  messages: HistoryMessage[],
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
  for (const m of [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
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
