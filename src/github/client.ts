import { z } from 'zod';

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const API = 'https://api.github.com';
/** Upper bound on pages followed per listing (100 items each). */
const MAX_PAGES = 10;

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  /** completed, not_planned, duplicate, reopened, or null. */
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  labels: string[];
}

const issueSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    state: z.enum(['open', 'closed']),
    state_reason: z.string().nullish(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullish(),
    labels: z
      .array(z.union([z.string(), z.object({ name: z.string() })]))
      .optional()
      .default([]),
  })
  .transform((i): IssueSummary => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    state: i.state,
    stateReason: i.state_reason ?? null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at ?? null,
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
  }));

/** A change on an issue, as the tracker reports it. */
export type IssueChange =
  | { kind: 'comment'; author: string; body: string; url: string; team: boolean }
  | { kind: 'labeled'; label: string }
  | { kind: 'assigned'; assignee: string }
  | { kind: 'pr'; number: number; title: string; url: string }
  | { kind: 'closed'; reason: string | null }
  | { kind: 'reopened' }
  | { kind: 'gone' };

/** A timeline entry: its time and the change, or null for events nobody is told about. */
export interface TimelineEntry {
  at: string;
  change: IssueChange | null;
}

/** Comment authors whose text is quoted in Discord; others are only counted. */
const TEAM = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const login = z.object({ login: z.string() }).nullish();

const timelineEntrySchema = z.union([
  z
    .object({
      event: z.literal('commented'),
      created_at: z.string(),
      user: login,
      body: z.string().nullish(),
      author_association: z.string().nullish(),
      html_url: z.string(),
    })
    .transform((e): TimelineEntry => ({
      at: e.created_at,
      change: {
        kind: 'comment',
        author: e.user?.login ?? 'unknown',
        body: e.body ?? '',
        url: e.html_url,
        team: TEAM.has(e.author_association ?? ''),
      },
    })),
  z
    .object({
      event: z.literal('labeled'),
      created_at: z.string(),
      label: z.object({ name: z.string() }),
    })
    .transform((e): TimelineEntry => ({
      at: e.created_at,
      change: { kind: 'labeled', label: e.label.name },
    })),
  z
    .object({ event: z.literal('assigned'), created_at: z.string(), assignee: login })
    .transform((e): TimelineEntry => ({
      at: e.created_at,
      change: { kind: 'assigned', assignee: e.assignee?.login ?? 'unknown' },
    })),
  z
    .object({
      event: z.literal('cross-referenced'),
      created_at: z.string(),
      source: z.object({
        issue: z
          .object({
            number: z.number(),
            title: z.string(),
            html_url: z.string(),
            pull_request: z.unknown().optional(),
          })
          .optional(),
      }),
    })
    .transform((e): TimelineEntry => {
      const i = e.source.issue;
      // Only pull requests: a mention from another issue is not progress on this one.
      return {
        at: e.created_at,
        change:
          i && i.pull_request !== undefined
            ? { kind: 'pr', number: i.number, title: i.title, url: i.html_url }
            : null,
      };
    }),
  z
    .object({
      event: z.literal('closed'),
      created_at: z.string(),
      state_reason: z.string().nullish(),
    })
    .transform((e): TimelineEntry => ({
      at: e.created_at,
      change: { kind: 'closed', reason: e.state_reason ?? null },
    })),
  z
    .object({ event: z.literal('reopened'), created_at: z.string() })
    .transform((e): TimelineEntry => ({ at: e.created_at, change: { kind: 'reopened' } })),
  // Anything else with a time (renamed, mentioned, …) only moves the cursor.
  z
    .object({ created_at: z.string() })
    .transform((e): TimelineEntry => ({ at: e.created_at, change: null })),
]);

export interface Release {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  notes: string;
}

const releaseSchema = z
  .object({
    tag_name: z.string(),
    name: z.string().nullish(),
    html_url: z.string(),
    published_at: z.string().nullish(),
    body: z.string().nullish(),
  })
  .transform((r): Release => ({
    tag: r.tag_name,
    name: r.name?.trim() || r.tag_name,
    url: r.html_url,
    publishedAt: r.published_at ?? null,
    notes: r.body ?? '',
  }));

export type ChangedIssues =
  { notModified: true } | { notModified: false; issues: IssueSummary[]; etag: string | undefined };

/** The GitHub REST calls the bot needs, on plain fetch. */
export class GithubClient {
  constructor(
    /** Without a token, only public data can be read (60 requests an hour). */
    private readonly token: string | undefined,
    readonly repo: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request(
    url: string,
    init: { method?: string; body?: unknown; etag?: string; anonymous?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'atlantis-oracle',
    };
    if (this.token && !init.anonymous) headers.Authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.etag) headers['If-None-Match'] = init.etag;
    const res = await this.fetchFn(url.startsWith('http') ? url : `${API}${url}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 304) {
      const detail = await res.text().catch(() => '');
      throw new GithubError(`GitHub returned ${res.status}: ${detail.slice(0, 300)}`, res.status);
    }
    return res;
  }

  /** Fetches `first` and every `rel="next"` page after it. */
  private async paginate(first: Response): Promise<unknown[]> {
    const items: unknown[] = [];
    let res = first;
    for (let page = 0; ; page++) {
      items.push(...((await res.json()) as unknown[]));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
      if (!next || page + 1 >= MAX_PAGES) return items;
      res = await this.request(next);
    }
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<IssueSummary> {
    const res = await this.request(`/repos/${this.repo}/issues`, {
      method: 'POST',
      body: {
        title: input.title,
        body: input.body,
        ...(input.labels.length > 0 ? { labels: input.labels } : {}),
      },
    });
    return issueSchema.parse(await res.json());
  }

  /**
   * Issues and pull requests updated at or after `since`. With the ETag of an
   * earlier identical request, "nothing new" is a free 304.
   */
  async changedIssues(since: string, etag?: string): Promise<ChangedIssues> {
    const query = new URLSearchParams({
      state: 'all',
      since,
      sort: 'updated',
      direction: 'asc',
      per_page: '100',
    });
    const res = await this.request(`/repos/${this.repo}/issues?${query}`, { etag });
    if (res.status === 304) return { notModified: true };
    const newEtag = res.headers.get('etag') ?? undefined;
    const issues = (await this.paginate(res)).flatMap((i) => {
      const parsed = issueSchema.safeParse(i);
      return parsed.success ? [parsed.data] : [];
    });
    return { notModified: false, issues, etag: newEtag };
  }

  /** One issue, or `gone` when it was deleted or moved to another repository. */
  async issue(number: number): Promise<IssueSummary | 'gone'> {
    try {
      const res = await this.request(`/repos/${this.repo}/issues/${number}`);
      const issue = issueSchema.parse(await res.json());
      // A transferred issue redirects to its new repository.
      return issue.url.includes(`/${this.repo}/issues/`) ? issue : 'gone';
    } catch (err) {
      if (err instanceof GithubError && (err.status === 404 || err.status === 410)) return 'gone';
      throw err;
    }
  }

  /**
   * The newest published release (not a draft or prerelease), or null when there
   * is none. A token that may not read releases (a fine-grained token without
   * Contents access) is dropped for a second, anonymous try: the repo is public.
   */
  async latestRelease(): Promise<Release | null> {
    const path = `/repos/${this.repo}/releases/latest`;
    const get = async (anonymous: boolean) => {
      try {
        return releaseSchema.parse(await (await this.request(path, { anonymous })).json());
      } catch (err) {
        if (err instanceof GithubError && err.status === 404) return null;
        throw err;
      }
    };
    if (!this.token) return get(true);
    try {
      const release = await get(false);
      if (release) return release;
    } catch (err) {
      if (!(err instanceof GithubError && (err.status === 401 || err.status === 403))) throw err;
    }
    return get(true);
  }

  /** The issue's timeline (comments, labels, references, closing), oldest first. */
  async timeline(number: number): Promise<TimelineEntry[]> {
    const res = await this.request(`/repos/${this.repo}/issues/${number}/timeline?per_page=100`);
    return (await this.paginate(res)).flatMap((e) => {
      const parsed = timelineEntrySchema.safeParse(e);
      return parsed.success ? [parsed.data] : [];
    });
  }
}
