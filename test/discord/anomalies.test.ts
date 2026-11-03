import { describe, expect, it } from 'vitest';
import {
  anomalyThreadName,
  formatAnomalyList,
  formatAnomalyUpdate,
  isAnomalyThreadName,
  quoteComment,
  shouldPing,
} from '../../src/discord/anomalies.js';
import type { IssueChange } from '../../src/github/client.js';
import type { AnomalyUpdate } from '../../src/github/tracker.js';
import { anomaly } from '../helpers/anomaly.js';

const update = (changes: IssueChange[], extra: Partial<AnomalyUpdate['anomaly']> = {}) => ({
  anomaly: anomaly(7, extra),
  issue: { number: 7, title: 'Upkeep', url: 'https://gh/7' },
  changes,
});
const team = (body: string, author = 'rmstdope'): IssueChange => ({
  kind: 'comment',
  author,
  body,
  url: 'https://gh/7#c',
  team: true,
});
const stranger: IssueChange = {
  kind: 'comment',
  author: 'x',
  body: '@everyone buy now',
  url: 'https://gh/7#s',
  team: false,
};

describe('formatAnomalyUpdate', () => {
  it('quotes a single team comment', () => {
    expect(formatAnomalyUpdate(update([team('Confirmed.\nFix coming.')]))).toBe(
      '**rmstdope** transmitted on anomaly #7:\n> Confirmed.\n> Fix coming.\n[View on GitHub](<https://gh/7#c>)',
    );
  });

  it('only counts comments from outside the team', () => {
    const text = formatAnomalyUpdate(update([stranger, stranger]));
    expect(text).toBe(
      'Anomaly #7 received 2 transmissions from outside the Collective: [read on GitHub](<https://gh/7>)',
    );
    expect(text).not.toContain('buy now');
  });

  it('writes single changes as sentences', () => {
    const one = (c: IssueChange) => formatAnomalyUpdate(update([c]));
    expect(one({ kind: 'labeled', label: 'confirmed' })).toBe(
      'Anomaly #7 classified: `confirmed`.',
    );
    expect(one({ kind: 'pr', number: 12, title: 'Fix [x]', url: 'https://p' })).toBe(
      'A correction is being assimilated: [PR #12 · Fix x](<https://p>)',
    );
    expect(one({ kind: 'closed', reason: 'completed' })).toBe(
      'Anomaly #7 has been corrected. Resistance was futile.',
    );
    expect(one({ kind: 'closed', reason: 'not_planned' })).toContain('deemed irrelevant');
    expect(one({ kind: 'reopened' })).toBe('Anomaly #7 has been reactivated.');
    expect(one({ kind: 'gone' })).toBe('Anomaly #7 can no longer be located. Tracking has ended.');
  });

  it('combines several changes and quotes the latest team comment', () => {
    const text = formatAnomalyUpdate(
      update([
        { kind: 'labeled', label: 'confirmed' },
        team('first'),
        stranger,
        team('second', 'helper'),
      ]),
    );
    expect(text).toBe(
      [
        'Anomaly #7 has changed state:',
        '- classified: `confirmed`',
        '- 2 transmissions from **rmstdope**, **helper** (latest below)',
        '- 1 transmission from outside the Collective: [read on GitHub](<https://gh/7>)',
        '> second',
        '[View on GitHub](<https://gh/7#c>)',
      ].join('\n'),
    );
  });

  it('puts the ping in front', () => {
    expect(formatAnomalyUpdate(update([{ kind: 'reopened' }]), 'u1')).toBe(
      '<@u1>, anomaly #7 has been reactivated.',
    );
  });
});

describe('wishes', () => {
  const wish = (changes: IssueChange[]) => update(changes, { kind: 'wish' });
  it('use their own words', () => {
    expect(formatAnomalyUpdate(wish([{ kind: 'closed', reason: 'completed' }]), 'u1')).toBe(
      '<@u1>, wish #7 has been granted. Your distinctiveness has been added to our own.',
    );
    expect(formatAnomalyUpdate(wish([{ kind: 'closed', reason: 'not_planned' }]))).toBe(
      'Wish #7 has been deemed irrelevant and will not be granted.',
    );
    expect(formatAnomalyUpdate(wish([{ kind: 'pr', number: 3, title: 'T', url: 'u' }]))).toBe(
      'An implementation is being assimilated: [PR #3 · T](<u>)',
    );
    expect(formatAnomalyUpdate(wish([team('Nice idea')]))).toContain('transmitted on wish #7:');
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
  it('pings on the first update in a new thread and when the issue ends', () => {
    expect(shouldPing(update([{ kind: 'reopened' }]))).toBe(true);
    expect(shouldPing(update([{ kind: 'reopened' }], { threadId: 't' }))).toBe(false);
    expect(shouldPing(update([{ kind: 'reopened' }], { inThread: true }))).toBe(false);
    expect(shouldPing(update([{ kind: 'closed', reason: null }], { threadId: 't' }))).toBe(true);
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
