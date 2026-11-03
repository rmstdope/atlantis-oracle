import type { Anomaly } from '../../src/github/store.js';

/** A tracked report with sensible defaults. */
export const anomaly = (issue: number, extra: Partial<Anomaly> = {}): Anomaly => ({
  issue,
  kind: 'bug',
  url: `https://github.com/o/r/issues/${issue}`,
  title: `Issue ${issue}`,
  reporterId: 'u1',
  channelId: 'c1',
  inThread: false,
  replyMessageId: 'm1',
  threadId: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  lastEventAt: '2026-11-01T10:00:00Z',
  state: 'open',
  closedAt: null,
  stateReason: null,
  labels: [],
  ...extra,
});
