import { describe, expect, it, vi } from 'vitest';
import { GithubClient } from '../../src/github/client.js';

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  html_url: `https://github.com/o/r/issues/${n}`,
  state: 'open',
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-02T10:00:00Z',
  ...extra,
});

function fake(...responses: Response[]) {
  const fetchFn = vi.fn(async () => responses.shift()!);
  return { fetchFn, client: new GithubClient('tok', 'o/r', fetchFn as unknown as typeof fetch) };
}
const call = (f: ReturnType<typeof vi.fn>, i = 0) =>
  f.mock.calls[i] as unknown as [string, RequestInit & { headers: Record<string, string> }];

describe('GithubClient.changedIssues', () => {
  it('asks for changes since a time and returns the ETag', async () => {
    const { fetchFn, client } = fake(Response.json([issue(7)], { headers: { etag: 'W/"abc"' } }));
    const res = await client.changedIssues('2026-11-01T00:00:00Z', 'W/"old"');
    const [url, init] = call(fetchFn);
    expect(url).toContain('/repos/o/r/issues?state=all&since=2026-11-01T00%3A00%3A00Z');
    expect(init.headers['If-None-Match']).toBe('W/"old"');
    expect(res).toEqual({
      notModified: false,
      etag: 'W/"abc"',
      issues: [expect.objectContaining({ number: 7, state: 'open', closedAt: null })],
    });
  });

  it('reports 304 as not modified', async () => {
    const { client } = fake(new Response(null, { status: 304 }));
    expect(await client.changedIssues('2026-11-01T00:00:00Z', 'x')).toEqual({ notModified: true });
  });

  it('follows pagination links', async () => {
    const { fetchFn, client } = fake(
      Response.json([issue(1)], {
        headers: { link: '<https://api.github.com/next?page=2>; rel="next"' },
      }),
      Response.json([issue(2)]),
    );
    const res = await client.changedIssues('2026-11-01T00:00:00Z');
    expect(call(fetchFn, 1)[0]).toBe('https://api.github.com/next?page=2');
    expect(res.notModified === false && res.issues.map((i) => i.number)).toEqual([1, 2]);
  });
});

describe('GithubClient.issue', () => {
  it('reports deleted and transferred issues as gone', async () => {
    expect(await fake(new Response('', { status: 404 })).client.issue(7)).toBe('gone');
    expect(await fake(new Response('', { status: 410 })).client.issue(7)).toBe('gone');
    const moved = issue(3, { html_url: 'https://github.com/other/repo/issues/3' });
    expect(await fake(Response.json(moved)).client.issue(7)).toBe('gone');
    expect(await fake(Response.json(issue(7))).client.issue(7)).toMatchObject({ number: 7 });
  });

  it('throws on other errors', async () => {
    await expect(fake(new Response('', { status: 500 })).client.issue(7)).rejects.toThrow();
  });
});

describe('GithubClient.timeline', () => {
  it('keeps comments and only the time of other events', async () => {
    const at = '2026-11-02T10:00:00Z';
    const { client } = fake(
      Response.json([
        {
          event: 'commented',
          created_at: at,
          user: { login: 'rmstdope' },
          body: 'Confirmed',
          author_association: 'OWNER',
          html_url: 'https://c/1',
        },
        {
          event: 'commented',
          created_at: at,
          user: { login: 'stranger' },
          body: 'me too',
          author_association: 'NONE',
          html_url: 'https://c/2',
        },
        { event: 'labeled', created_at: at, label: { name: 'confirmed' } },
        { event: 'assigned', created_at: at, assignee: { login: 'rmstdope' } },
        {
          event: 'cross-referenced',
          created_at: at,
          source: {
            issue: { number: 12, title: 'Fix', html_url: 'https://p/12', pull_request: {} },
          },
        },
        {
          event: 'cross-referenced',
          created_at: at,
          source: { issue: { number: 13, title: 'Other issue', html_url: 'https://i/13' } },
        },
        { event: 'closed', created_at: at, state_reason: 'completed' },
        { event: 'reopened', created_at: at },
        { event: 'renamed', created_at: at },
        { event: 'committed', sha: 'abc' },
      ]),
    );
    const entries = await client.timeline(7);
    expect(entries.map((e) => e.comment)).toEqual([
      { author: 'rmstdope', body: 'Confirmed', url: 'https://c/1', team: true },
      { author: 'stranger', body: 'me too', url: 'https://c/2', team: false },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(entries.every((e) => e.at === at)).toBe(true);
  });
});

describe('GithubClient.latestRelease', () => {
  const release = {
    tag_name: 'v1.4.0',
    name: 'HUD 1.4',
    html_url: 'https://github.com/o/r/releases/tag/v1.4.0',
    published_at: '2026-10-30T12:00:00Z',
    body: 'Notes',
  };
  const client = (token: string | undefined, ...responses: Response[]) => {
    const fetchFn = vi.fn(async () => responses.shift()!);
    return { fetchFn, gh: new GithubClient(token, 'o/r', fetchFn as unknown as typeof fetch) };
  };

  it('returns the latest release', async () => {
    const { fetchFn, gh } = client('tok', Response.json(release));
    expect(await gh.latestRelease()).toEqual({
      tag: 'v1.4.0',
      name: 'HUD 1.4',
      url: 'https://github.com/o/r/releases/tag/v1.4.0',
      publishedAt: '2026-10-30T12:00:00Z',
      notes: 'Notes',
    });
    expect(call(fetchFn)[0]).toBe('https://api.github.com/repos/o/r/releases/latest');
    expect(call(fetchFn)[1].headers.Authorization).toBe('Bearer tok');
  });

  it('retries without the token when GitHub refuses it', async () => {
    for (const status of [403, 404]) {
      const { fetchFn, gh } = client('tok', new Response('', { status }), Response.json(release));
      expect(await gh.latestRelease()).toMatchObject({ tag: 'v1.4.0' });
      expect(call(fetchFn, 1)[1].headers.Authorization).toBeUndefined();
    }
  });

  it('works without a token and reports no release as null', async () => {
    const { fetchFn, gh } = client(undefined, new Response('', { status: 404 }));
    expect(await gh.latestRelease()).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(call(fetchFn)[1].headers.Authorization).toBeUndefined();
  });

  it('uses the tag when the release has no name', async () => {
    const { gh } = client(undefined, Response.json({ ...release, name: '' }));
    expect(await gh.latestRelease()).toMatchObject({ name: 'v1.4.0' });
  });
});
