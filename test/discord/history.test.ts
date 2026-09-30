import { describe, expect, it } from 'vitest';
import { formatQuestion } from '../../src/discord/format.js';
import { buildTurns, type HistoryMessage } from '../../src/discord/history.js';

const BOT = 'bot';
let t = 0;
const msg = (authorId: string, content: string): HistoryMessage => ({
  authorId,
  content,
  createdTimestamp: ++t,
});

describe('buildTurns', () => {
  it('starts with the question from the starter message and alternates roles', () => {
    const starter = msg(BOT, formatQuestion('u1', 'What does TACT do?'));
    const messages = [
      msg(BOT, 'Part one of the answer.'),
      msg(BOT, 'Part two.\n-# model · standard · repo@abc · AI answer'),
      msg('u1', 'And at level 5?'),
    ];
    expect(buildTurns(BOT, starter, [...messages].reverse())).toEqual([
      { role: 'user', content: 'What does TACT do?' },
      { role: 'assistant', content: 'Part one of the answer.\n\nPart two.' },
      { role: 'user', content: 'And at level 5?' },
    ]);
  });

  it('ignores progress messages', () => {
    const turns = buildTurns(BOT, undefined, [
      msg('u1', 'q1'),
      msg(BOT, 'a1'),
      msg('u1', 'q2'),
      msg(BOT, '🔎 Researching… (12s)\n-# Searching the rules for “x”'),
    ]);
    expect(turns).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('merges consecutive user messages from different users', () => {
    const turns = buildTurns(BOT, undefined, [msg('u1', 'a'), msg('u2', 'b')]);
    expect(turns).toEqual([{ role: 'user', content: 'a\n\nb' }]);
  });

  it('drops trailing assistant turns and empty messages', () => {
    const turns = buildTurns(BOT, undefined, [
      msg('u1', 'q'),
      msg('u1', '  '),
      msg(BOT, 'Sorry, error'),
    ]);
    expect(turns).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('caps very long turns', () => {
    const turns = buildTurns(BOT, undefined, [msg('u1', 'z'.repeat(5000))]);
    expect(turns[0]!.content.length).toBe(2001);
  });
});
