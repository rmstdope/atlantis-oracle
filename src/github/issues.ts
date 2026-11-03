import type { GithubClient, IssueSummary } from './client.js';
import type { IssueKind } from './store.js';

export const MAX_TITLE_LENGTH = 80;

const TITLE_PREFIX: Record<IssueKind, string> = { bug: '[Bug]', wish: '[Wish]' };
const BYLINE: Record<IssueKind, string> = { bug: 'Reported', wish: 'Wished for' };

/** A bug report (/report-bug) or a feature wish (/wish) from Discord. */
export interface IssueReport {
  kind: IssueKind;
  /** The player's text, as typed. */
  text: string;
  /** Discord display name of the reporter. */
  reporter: string;
  /** Link to the Discord message or thread the report came from. */
  sourceUrl?: string;
}

/**
 * Breaks GitHub @mentions and #references so a report typed in Discord cannot
 * ping GitHub users or cross-link other issues from the owner's account.
 */
export function neutralize(text: string): string {
  return text.replace(/@(?=[\w-])/g, '@​').replace(/#(?=\d)/g, '#​');
}

/** First line of the report, shortened to fit a title. */
export function issueTitle(text: string, kind: IssueKind = 'bug'): string {
  const firstLine = text.trim().split('\n')[0]!.trim();
  const short =
    firstLine.length > MAX_TITLE_LENGTH
      ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
      : firstLine;
  return `${TITLE_PREFIX[kind]} ${neutralize(short)}`;
}

export function issueBody(report: IssueReport): string {
  const byline = `${BYLINE[report.kind]} by **${neutralize(report.reporter)}** via Discord${report.sourceUrl ? ` (${report.sourceUrl})` : ''}`;
  return `${neutralize(report.text.trim())}\n\n---\n${byline}\n`;
}

/** Files the report or wish as an issue. */
export async function fileIssue(
  client: GithubClient,
  report: IssueReport,
  labels: string[] = [],
): Promise<IssueSummary> {
  return client.createIssue({
    title: issueTitle(report.text, report.kind),
    body: issueBody(report),
    labels,
  });
}
