import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** A bug report or wish filed from Discord whose issue is being watched. */
const anomalySchema = z.object({
  issue: z.number().int(),
  /** bug: /report-bug, wish: /wish. */
  kind: z.enum(['bug', 'wish']).default('bug'),
  url: z.string(),
  title: z.string(),
  reporterId: z.string(),
  /** Where the command was used; a thread when `inThread`. */
  channelId: z.string(),
  inThread: z.boolean(),
  /** The public reply with the issue link. */
  replyMessageId: z.string(),
  /** Thread started from the reply at the first update. */
  threadId: z.string().nullable(),
  createdAt: z.string(),
  /** The issue's updated_at when it was last processed. */
  updatedAt: z.string(),
  /** Time of the newest timeline entry already reported. */
  lastEventAt: z.string(),
  state: z.enum(['open', 'closed']),
  closedAt: z.string().nullable(),
  /** completed, not_planned, … for closed issues. */
  stateReason: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
});
export type Anomaly = z.output<typeof anomalySchema>;
export type IssueKind = Anomaly['kind'];

const fileSchema = z.object({
  version: z.literal(1),
  poll: z.object({
    /** `since` of the changed-issues query: the newest updated_at seen. */
    since: z.string().optional(),
    etag: z.string().optional(),
    /** Last check of every tracked issue for deletion or transfer. */
    verifiedAt: z.string().optional(),
  }),
  anomalies: z.array(anomalySchema),
});
export type AnomalyFile = z.infer<typeof fileSchema>;

/** The tracked reports, kept in one JSON file. */
export class AnomalyStore {
  private constructor(
    private readonly file: string,
    readonly data: AnomalyFile,
  ) {}

  /** Loads the file; a missing file is an empty store, an invalid one an error. */
  static async load(file: string): Promise<AnomalyStore> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return new AnomalyStore(file, { version: 1, poll: {}, anomalies: [] });
    }
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`${file} is not a valid anomaly store: ${parsed.error.message}`);
    }
    return new AnomalyStore(file, parsed.data);
  }

  get anomalies(): Anomaly[] {
    return this.data.anomalies;
  }

  find(issue: number): Anomaly | undefined {
    return this.data.anomalies.find((a) => a.issue === issue);
  }

  add(anomaly: Anomaly): void {
    this.data.anomalies = this.data.anomalies.filter((a) => a.issue !== anomaly.issue);
    this.data.anomalies.push(anomaly);
  }

  remove(issue: number): void {
    this.data.anomalies = this.data.anomalies.filter((a) => a.issue !== issue);
  }

  private saving: Promise<void> = Promise.resolve();

  /** Writes a temp file and renames it, so a crash never leaves half a file. Saves run in order. */
  save(): Promise<void> {
    const run = async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
      await rename(tmp, this.file);
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }
}
