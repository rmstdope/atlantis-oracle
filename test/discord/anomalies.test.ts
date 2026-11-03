import { describe, expect, it } from 'vitest';
import {
  anomalyThreadName,
  formatAnomalyList,
  formatAnomalyUpdate,
  isAnomalyThreadName,
  quoteComment,
  shouldPing,
} from '../../src/discord/anomalies.js';
import type { IssueComment } from '../../src/github/client.js';
import type { AnomalyUpdate } from '../../src/github/tracker.js';
import { anomaly } from '../helpers/anomaly.js';

const update = (comments: IssueComment[], extra: Partial<AnomalyUpdate['anomaly']> = {}) => ({
  anomaly: anomaly(7, extra),
  issue: { number: 7, title: 'Upkeep', url: 'https://gh/7' },
  comments,
});
const team = (body: string, author = 'rmstdope', url = 'https://gh/7#c'): IssueComment => ({
  author,
  body,
  url,
  team: true,
});
const stranger: IssueComment = {
  author: 'x',
  body: '@everyone buy now',
  url: 'https://gh/7#s',
  team: false,
};

describe('formatAnomalyUpdate', () => {
  it('quotes a team comment', () => {
    expect(formatAnomalyUpdate(update([team('Confirmed.\nFix coming.')]))).toBe(
      '**rmstdope** transmitted on anomaly #7:\n> Confirmed.\n> Fix coming.\n[View on GitHub](<https://gh/7#c>)',
    );
  });

  it('names wishes as wishes', () => {
    expect(formatAnomalyUpdate(update([team('Nice idea')], { kind: 'wish' }))).toMatch(
      /^\*\*rmstdope\*\* transmitted on wish #7:/,
    );
  });

  it('quotes each team comment and counts the others', () => {
    const text = formatAnomalyUpdate(
      update([team('first'), stranger, team('second', 'helper', 'https://gh/7#d')]),
    );
    expect(text).toBe(
      [
        '**rmstdope** transmitted on anomaly #7:\n> first\n[View on GitHub](<https://gh/7#c>)',
        '**helper** transmitted on anomaly #7:\n> second\n[View on GitHub](<https://gh/7#d>)',
        '1 transmission from outside the Collective on anomaly #7: [read on GitHub](<https://gh/7>)',
      ].join('\n\n'),
    );
    expect(text).not.toContain('buy now');
  });

  it('sums up comments that do not fit in one message', () => {
    const many = Array.from({ length: 20 }, (_, i) => team(`${i} ${'x'.repeat(250)}`));
    const text = formatAnomalyUpdate(update(many));
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toMatch(
      /\n\n… and \d+ more transmissions: \[read on GitHub\]\(<https:\/\/gh\/7>\)$/,
    );
  });

  it('puts the ping in front', () => {
    expect(formatAnomalyUpdate(update([team('Hi')]), 'u1')).toMatch(
      /^<@u1>, \*\*rmstdope\*\* transmitted/,
    );
  });
});

describe('formatAnomalyList', () => {
  it('lists reports and wishes newest first with status and labels', () => {
    const text = formatAnomalyList(
      [
        anomaly(7, { title: '[Bug] Upkeep wrong', state: 'closed', stateReason: 'completed' }),
        anomaly(12, {
          kind: 'wish',
          title: '[Wish] Dark mode',
          labels: ['planned'],
          createdAt: '2026-11-02T10:00:00Z',
        }),
      ],
      14,
    );
    expect(text).toBe(
      [
        'Your transmissions to the Collective:',
        '- [Wish #12](<https://github.com/o/r/issues/12>) · Dark mode · **open** · `planned`',
        '- [Anomaly #7](<https://github.com/o/r/issues/7>) · Upkeep wrong · **corrected**',
        '-# Closed ones are listed for 14 days.',
      ].join('\n'),
    );
  });

  it('says when there is nothing', () => {
    expect(formatAnomalyList([], 14)).toContain('no open anomalies or wishes');
  });
});

describe('quoteComment', () => {
  it('drops HTML comments and shortens long text', () => {
    expect(quoteComment('<!-- template -->\nHi')).toBe('> Hi');
    expect(quoteComment('x'.repeat(400))).toBe(`> ${'x'.repeat(300)}…`);
    expect(quoteComment('1\n2\n3\n4\n5\n6\n7\n8')).toBe('> 1\n> 2\n> 3\n> 4\n> 5\n> 6…');
  });
});

describe('shouldPing', () => {
  it('pings only on the first update, which starts the thread', () => {
    expect(shouldPing(update([team('a')]))).toBe(true);
    expect(shouldPing(update([team('a')], { threadId: 't' }))).toBe(false);
    expect(shouldPing(update([team('a')], { inThread: true }))).toBe(false);
  });
});

describe('anomaly thread names', () => {
  it('are recognized and limited to 100 characters', () => {
    expect(anomalyThreadName('bug', 7, '[Bug] Upkeep')).toBe('Anomaly #7 · Upkeep');
    expect(anomalyThreadName('wish', 12, '[Wish] Dark mode')).toBe('Wish #12 · Dark mode');
    expect(anomalyThreadName('bug', 7, 'x'.repeat(200))).toHaveLength(100);
    expect(isAnomalyThreadName('Anomaly #7 · Upkeep')).toBe(true);
    expect(isAnomalyThreadName('Wish #12 · Dark mode')).toBe(true);
    expect(isAnomalyThreadName('How does upkeep work · standard')).toBe(false);
  });
});
