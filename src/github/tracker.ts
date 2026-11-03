import type { Logger } from '../logger.js';
import type { GithubClient, IssueComment, IssueSummary } from './client.js';
import type { Anomaly, AnomalyStore } from './store.js';

export interface AnomalyUpdate {
  anomaly: Anomaly;
  issue: Pick<IssueSummary, 'number' | 'title' | 'url'>;
  /** New comments, oldest first. */
  comments: IssueComment[];
}

/**
 * Posts an update. Returns the id of a thread it created, so later updates go
 * there. Throwing leaves the cursor in place: the update is retried next poll.
 */
export type Deliver = (update: AnomalyUpdate) => Promise<{ threadId?: string } | void>;

/** Where the report was made, for posting updates. */
export type ReportOrigin = Pick<
  Anomaly,
  'kind' | 'reporterId' | 'channelId' | 'inThread' | 'replyMessageId'
>;

type Source = Pick<GithubClient, 'changedIssues' | 'issue' | 'timeline'>;

const DAY_MS = 86_400_000;
/** First poll after start, so a restart reports promptly. */
const FIRST_POLL_MS = 10_000;

const time = (iso: string) => Date.parse(iso);

/** Watches the issues filed through /report-bug and /wish and reports new comments. */
export class AnomalyTracker {
  private running = false;

  constructor(
    private readonly store: AnomalyStore,
    private readonly source: Source,
    private readonly opts: { trackClosedDays: number },
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async track(issue: IssueSummary, origin: ReportOrigin): Promise<void> {
    this.store.add({
      issue: issue.number,
      url: issue.url,
      title: issue.title,
      ...origin,
      threadId: null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      lastEventAt: issue.createdAt,
      state: issue.state,
      closedAt: issue.closedAt,
      stateReason: issue.stateReason,
      labels: issue.labels,
    });
    await this.store.save();
  }

  /** The tracked issues filed by one Discord user. */
  reportsBy(userId: string): Anomaly[] {
    return this.store.anomalies.filter((a) => a.reporterId === userId);
  }

  /** One round: find changed issues, report what happened, forget old ones. */
  async poll(deliver: Deliver): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.store.anomalies.length === 0) return;
      await this.verifyIfDue();

      const poll = this.store.data.poll;
      const since =
        poll.since ??
        this.store.anomalies.map((a) => a.createdAt).reduce((a, b) => (time(a) < time(b) ? a : b));
      const res = await this.source.changedIssues(since, poll.etag);
      if (!res.notModified) {
        let newest = since;
        let allDelivered = true;
        for (const issue of res.issues) {
          if (time(issue.updatedAt) > time(newest)) newest = issue.updatedAt;
          const anomaly = this.store.find(issue.number);
          if (!anomaly || time(issue.updatedAt) <= time(anomaly.updatedAt)) continue;
          try {
            await this.process(anomaly, issue, deliver);
          } catch (err) {
            allDelivered = false;
            this.logger.warn({ err, issue: issue.number }, 'Could not report anomaly update');
          }
        }
        // On a failure, ask again from the same point next time; processed
        // issues are skipped by their own updatedAt.
        if (allDelivered) this.store.data.poll = { ...poll, since: newest, etag: res.etag };
      }
      this.prune();
      await this.store.save();
    } finally {
      this.running = false;
    }
  }

  private async process(anomaly: Anomaly, issue: IssueSummary, deliver: Deliver): Promise<void> {
    const entries = await this.source.timeline(issue.number);
    const fresh = entries.filter((e) => time(e.at) > time(anomaly.lastEventAt));
    const comments = fresh.flatMap((e) => (e.comment ? [e.comment] : []));
    let threadId = anomaly.threadId;
    if (comments.length > 0) {
      const result = await deliver({ anomaly, issue, comments });
      if (result?.threadId) threadId = result.threadId;
      this.logger.info({ issue: issue.number, comments: comments.length }, 'Reported new comments');
    }
    Object.assign(anomaly, {
      title: issue.title,
      state: issue.state,
      closedAt: issue.closedAt,
      stateReason: issue.stateReason,
      labels: issue.labels,
      updatedAt: issue.updatedAt,
      threadId,
      lastEventAt: fresh.reduce(
        (latest, e) => (time(e.at) > time(latest) ? e.at : latest),
        anomaly.lastEventAt,
      ),
    } satisfies Partial<Anomaly>);
    await this.store.save();
  }

  /** Once a day: issues that were deleted or transferred never show up as changed. */
  private async verifyIfDue(): Promise<void> {
    const { verifiedAt } = this.store.data.poll;
    const now = this.now();
    if (verifiedAt && now.getTime() - time(verifiedAt) < DAY_MS) return;
    for (const anomaly of [...this.store.anomalies]) {
      try {
        if ((await this.source.issue(anomaly.issue)) !== 'gone') continue;
        this.store.remove(anomaly.issue);
        this.logger.info({ issue: anomaly.issue }, 'Tracked issue is gone; stopped tracking');
      } catch (err) {
        this.logger.warn({ err, issue: anomaly.issue }, 'Could not verify tracked issue');
      }
    }
    this.store.data.poll.verifiedAt = now.toISOString();
  }

  private prune(): void {
    const cutoff = this.now().getTime() - this.opts.trackClosedDays * DAY_MS;
    for (const a of [...this.store.anomalies]) {
      if (a.state === 'closed' && a.closedAt && time(a.closedAt) <= cutoff) {
        this.store.remove(a.issue);
        this.logger.info({ issue: a.issue }, 'Stopped tracking closed anomaly');
      }
    }
  }

  /** Polls every `intervalMinutes`; returns a stop function. */
  start(intervalMinutes: number, deliver: Deliver): () => void {
    const run = () =>
      void this.poll(deliver).catch((err: unknown) => {
        this.logger.warn({ err }, 'Anomaly poll failed');
      });
    const first = setTimeout(run, FIRST_POLL_MS);
    const timer = setInterval(run, intervalMinutes * 60_000);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}
