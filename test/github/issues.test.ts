import { describe, expect, it, vi } from 'vitest';
import { GithubClient, GithubError } from '../../src/github/client.js';
import {
  fileIssue,
  issueBody,
  issueTitle,
  neutralize,
  type IssueReport,
} from '../../src/github/issues.js';

const report: IssueReport = {
  kind: 'bug',
  text: 'Wrong upkeep for leaders\nThe bot said 10 silver, rules say 20.',
  reporter: 'player1',
  sourceUrl: 'https://discord.com/channels/1/2',
};

describe('neutralize', () => {
  it('breaks GitHub mentions and issue references', () => {
    expect(neutralize('ping @octocat about #12, mail a@b.c')).toBe(
      'ping @​octocat about #​12, mail a@​b.c',
    );
    expect(neutralize('# heading and C# code')).toBe('# heading and C# code');
  });
});

describe('issueTitle', () => {
  it('uses the first line', () => {
    expect(issueTitle(report.text)).toBe('[Bug] Wrong upkeep for leaders');
  });

  it('marks wishes', () => {
    expect(issueTitle('Dark mode', 'wish')).toBe('[Wish] Dark mode');
  });

  it('shortens long lines', () => {
    const title = issueTitle('x'.repeat(200));
    expect(title).toBe(`[Bug] ${'x'.repeat(79)}…`);
  });
});

describe('issueBody', () => {
  it('contains the report and the reporter, nothing about the bot or the game', () => {
    const body = issueBody(report);
    expect(body).toContain('The bot said 10 silver, rules say 20.');
    expect(body).toContain('**player1** via Discord (https://discord.com/channels/1/2)');
    expect(body).not.toMatch(/Model|Game repo|Variant/);
  });

  it('says who wished for it', () => {
    expect(issueBody({ ...report, kind: 'wish' })).toContain('Wished for by **player1**');
  });

  it('leaves out the link when there is none', () => {
    const body = issueBody({ ...report, sourceUrl: undefined });
    expect(body).toMatch(/---\nReported by \*\*player1\*\* via Discord\n$/);
  });
});

describe('fileIssue', () => {
  const ghIssue = {
    number: 7,
    title: '[Bug] Wrong upkeep for leaders',
    html_url: 'https://github.com/owner/name/issues/7',
    state: 'open',
    created_at: '2026-11-03T14:02:11Z',
    updated_at: '2026-11-03T14:02:11Z',
  };
  const client = (fetchFn: unknown) =>
    new GithubClient('tok', 'owner/name', fetchFn as typeof fetch);

  it('posts the issue and returns it', async () => {
    const fetchFn = vi.fn(async () => Response.json(ghIssue, { status: 201 }));
    const issue = await fileIssue(client(fetchFn), report, ['bug']);
    expect(issue).toMatchObject({ number: 7, url: 'https://github.com/owner/name/issues/7' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/owner/name/issues');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const sent = JSON.parse(init.body as string);
    expect(sent.title).toBe('[Bug] Wrong upkeep for leaders');
    expect(sent.labels).toEqual(['bug']);
  });

  it('sends no labels when none are configured', async () => {
    const fetchFn = vi.fn(async () => Response.json(ghIssue));
    await fileIssue(client(fetchFn), report);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('labels');
  });

  it('throws GithubError on a failed request', async () => {
    const fetchFn = vi.fn(async () => new Response('Bad credentials', { status: 401 }));
    await expect(fileIssue(client(fetchFn), report)).rejects.toThrow(GithubError);
  });
});
