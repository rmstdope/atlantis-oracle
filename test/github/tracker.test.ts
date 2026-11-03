import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedIssues, IssueSummary, TimelineEntry } from '../../src/github/client.js';
import { AnomalyStore } from '../../src/github/store.js';
import { AnomalyTracker, type AnomalyUpdate } from '../../src/github/tracker.js';
import { anomaly } from '../helpers/anomaly.js';
import { silentLogger } from '../helpers/fixture.js';

const summary = (n: number, extra: Partial<IssueSummary> = {}): IssueSummary => ({
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
  state: 'open',
  stateReason: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-02T10:00:00Z',
  closedAt: null,
  labels: [],
  ...extra,
});

const comment = (at: string, body = 'Confirmed'): TimelineEntry => ({
  at,
  change: { kind: 'comment', author: 'rmstdope', body, url: 'https://c/1', team: true },
});

let dir: string;
let store: AnomalyStore;
let now: Date;
const source = {
  changedIssues: vi.fn<(since: string, etag?: string) => Promise<ChangedIssues>>(),
  issue: vi.fn<(n: number) => Promise<IssueSummary | 'gone'>>(),
  timeline: vi.fn<(n: number) => Promise<TimelineEntry[]>>(),
};
const tracker = () =>
  new AnomalyTracker(store, source, { trackClosedDays: 14 }, silentLogger, () => now);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'oracle-tracker-'));
  store = await AnomalyStore.load(path.join(dir, 'anomalies.json'));
  now = new Date('2026-11-03T12:00:00Z');
  vi.resetAllMocks();
  source.issue.mockImplementation(async (n) => summary(n));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AnomalyTracker', () => {
  it('tracks a new report from its creation time', async () => {
    await tracker().track(summary(7, { updatedAt: '2026-11-01T10:00:00Z' }), {
      kind: 'wish',
      reporterId: 'u1',
      channelId: 'c1',
      inThread: false,
      replyMessageId: 'm1',
    });
    const saved = await AnomalyStore.load(path.join(dir, 'anomalies.json'));
    expect(saved.find(7)).toMatchObject({
      kind: 'wish',
      lastEventAt: '2026-11-01T10:00:00Z',
      threadId: null,
    });
  });

  it('lists the reports of one user', () => {
    store.add(anomaly(7));
    store.add(anomaly(8, { reporterId: 'u2' }));
    expect(
      tracker()
        .reportsBy('u1')
        .map((a) => a.issue),
    ).toEqual([7]);
  });

  it('records state and labels of changed issues', async () => {
    store.add(anomaly(7));
    source.changedIssues.mockResolvedValue({
      notModified: false,
      etag: 'e',
      issues: [
        summary(7, {
          state: 'closed',
          stateReason: 'completed',
          closedAt: '2026-11-02T10:00:00Z',
          labels: ['confirmed'],
        }),
      ],
    });
    source.timeline.mockResolvedValue([]);
    await tracker().poll(vi.fn());
    expect(store.find(7)).toMatchObject({
      state: 'closed',
      stateReason: 'completed',
      labels: ['confirmed'],
    });
  });

  it('does nothing without tracked reports', async () => {
    await tracker().poll(vi.fn());
    expect(source.changedIssues).not.toHaveBeenCalled();
  });

  it('reports new timeline entries once and remembers the thread', async () => {
    store.add(anomaly(7));
    source.changedIssues.mockResolvedValueOnce({
      notModified: false,
      etag: 'e1',
      issues: [summary(3), summary(7)],
    });
    source.timeline.mockResolvedValue([
      { at: '2026-11-01T10:00:00Z', change: { kind: 'labeled', label: 'old' } },
      comment('2026-11-02T09:00:00Z'),
      { at: '2026-11-02T09:30:00Z', change: null },
    ]);
    const deliver = vi.fn(async (_: AnomalyUpdate) => ({ threadId: 't1' }));
    await tracker().poll(deliver);

    expect(source.changedIssues).toHaveBeenCalledWith('2026-11-01T10:00:00Z', undefined);
    expect(source.timeline).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0].changes).toEqual([comment('').change]);
    expect(store.find(7)).toMatchObject({
      threadId: 't1',
      lastEventAt: '2026-11-02T09:30:00Z',
      updatedAt: '2026-11-02T10:00:00Z',
    });
    expect(store.data.poll).toMatchObject({ since: '2026-11-02T10:00:00Z', etag: 'e1' });

    // Same issue again, unchanged: skipped. Then a 304: nothing at all.
    source.changedIssues.mockResolvedValueOnce({
      notModified: false,
      etag: 'e1',
      issues: [summary(7)],
    });
    await tracker().poll(deliver);
    source.changedIssues.mockResolvedValueOnce({ notModified: true });
    await tracker().poll(deliver);
    expect(source.changedIssues).toHaveBeenLastCalledWith('2026-11-02T10:00:00Z', 'e1');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('moves the cursor without a message when nothing reportable happened', async () => {
    store.add(anomaly(7));
    source.changedIssues.mockResolvedValue({ notModified: false, etag: 'e', issues: [summary(7)] });
    source.timeline.mockResolvedValue([{ at: '2026-11-02T09:00:00Z', change: null }]);
    const deliver = vi.fn();
    await tracker().poll(deliver);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.find(7)?.lastEventAt).toBe('2026-11-02T09:00:00Z');
  });

  it('retries an update whose delivery failed', async () => {
    store.add(anomaly(7));
    store.data.poll = { since: '2026-11-01T10:00:00Z', etag: 'e0', verifiedAt: now.toISOString() };
    source.changedIssues.mockResolvedValue({
      notModified: false,
      etag: 'e1',
      issues: [summary(7)],
    });
    source.timeline.mockResolvedValue([comment('2026-11-02T09:00:00Z')]);
    const deliver = vi.fn().mockRejectedValueOnce(new Error('discord down'));

    await tracker().poll(deliver);
    expect(store.find(7)?.lastEventAt).toBe('2026-11-01T10:00:00Z');
    expect(store.data.poll).toMatchObject({ since: '2026-11-01T10:00:00Z', etag: 'e0' });

    await tracker().poll(deliver);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(store.find(7)?.lastEventAt).toBe('2026-11-02T09:00:00Z');
    expect(store.data.poll.etag).toBe('e1');
  });

  it('stops tracking closed issues after the grace period', async () => {
    store.add(anomaly(7, { state: 'closed', closedAt: '2026-10-20T11:00:00Z' }));
    store.add(anomaly(8, { state: 'closed', closedAt: '2026-10-25T11:00:00Z' }));
    source.changedIssues.mockResolvedValue({ notModified: true });
    await tracker().poll(vi.fn());
    expect(store.anomalies.map((a) => a.issue)).toEqual([8]);
  });

  it('reports and forgets issues that are gone, checking once a day', async () => {
    store.add(anomaly(7));
    store.add(anomaly(8));
    source.issue.mockImplementation(async (n) => (n === 7 ? 'gone' : summary(n)));
    source.changedIssues.mockResolvedValue({ notModified: true });
    const deliver = vi.fn(async (_: AnomalyUpdate) => {});
    await tracker().poll(deliver);
    expect(deliver.mock.calls[0]![0]).toMatchObject({
      issue: { number: 7 },
      changes: [{ kind: 'gone' }],
    });
    expect(store.anomalies.map((a) => a.issue)).toEqual([8]);

    await tracker().poll(deliver);
    expect(source.issue).toHaveBeenCalledTimes(2);
    now = new Date('2026-11-04T12:00:01Z');
    await tracker().poll(deliver);
    expect(source.issue).toHaveBeenCalledTimes(3);
  });
});
