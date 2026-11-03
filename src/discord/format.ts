/** Discord's limit is 2000; leave room for fence repair and the footer. */
export const MAX_CHUNK = 1900;

const FENCE_RE = /^\s*```(\S*)/;

/** Returns the language of the fence left open at the end of `text`, or undefined if none. */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (m) open = open === undefined ? m[1]! : undefined;
  }
  return open;
}

function cutPoint(text: string, max: number): number {
  const window = text.slice(0, max);
  for (const sep of ['\n\n', '\n', ' ']) {
    const i = window.lastIndexOf(sep);
    if (i > max / 2) return i + sep.length;
  }
  return max;
}

/**
 * Splits text into Discord-sized messages, preferring paragraph and line
 * breaks, and closing/reopening code fences that span a split.
 */
export function splitMessage(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  let reopen = '';
  while (rest.length > 0) {
    rest = reopen + rest;
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    const budget = max - 4; // room for "\n```"
    const cut = cutPoint(rest, budget);
    let chunk = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    const lang = openFence(chunk);
    if (lang !== undefined) {
      chunk += '\n```';
      reopen = `\`\`\`${lang}\n`;
    } else {
      reopen = '';
    }
    chunks.push(chunk);
  }
  return chunks;
}

/** Discord subtext line appended to answers; history.ts strips it again. */
export function footer(info: {
  model: string;
  variant: string;
  repoUrl: string;
  commit: string;
}): string {
  const repo = info.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
  return `-# ${info.model} · ${info.variant} · ${repo}@${info.commit.slice(0, 7)} · We are not infallible. Verify the cited sources.`;
}

const QUESTION_PREFIX = '**Question:** ';
const QUESTION_SUFFIX = '[Accessing collective hive mind ... ]';

/** The /ask reply that becomes the thread's starter message. */
export function formatQuestion(userId: string, question: string): string {
  return `We are Borg!\n<@${userId}> asked:\n${QUESTION_PREFIX}${question}\n${QUESTION_SUFFIX}`;
}

const MAX_REPORT_TITLE = 100;

const FILED: Record<'bug' | 'wish', string> = {
  bug: 'reported an anomaly. It has been assimilated.',
  wish: 'submitted a wish. Your distinctiveness will be added to our own.',
};

/** The public reply to /report-bug and /wish: who, the text's first line, the issue link. */
export function formatIssueFiled(
  kind: 'bug' | 'wish',
  userId: string,
  text: string,
  issueUrl: string,
): string {
  const line = text.trim().split('\n')[0]!.trim();
  const title =
    line.length > MAX_REPORT_TITLE ? `${line.slice(0, MAX_REPORT_TITLE - 1).trimEnd()}…` : line;
  return `<@${userId}> ${FILED[kind]}\n> ${title}\n<${issueUrl}>`;
}

/**
 * Who asked: the first mention in the thread's starter message (the bot's
 * question header). The player's question comes after it, so a mention
 * inside the question can't take its place.
 */
export function parseAsker(content: string): string | undefined {
  return /<@!?(\d+)>/.exec(content)?.[1];
}

/** The reply to a message the topic check rejected. */
export const OFF_TOPIC_REPLY =
  'This query is irrelevant to the Collective. We answer questions about Atlantis: its rules, orders and mechanics.';

/**
 * History leaves rejected exchanges out. The whole message must be a known
 * rejection, so an answer that merely opens the same way stays; keep older
 * wordings in the list if the reply changes.
 */
const OFF_TOPIC_REPLIES = [OFF_TOPIC_REPLY];
export function isOffTopicReply(content: string): boolean {
  return OFF_TOPIC_REPLIES.includes(content.trim());
}

/**
 * The question in a bot message that is a question header (formatQuestion),
 * e.g. from /ask inside an answer thread; undefined for any other message.
 */
export function headerQuestion(content: string): string | undefined {
  return /^We are Borg!\n<@!?\d+> asked:\n/.test(content) ? parseQuestion(content) : undefined;
}

/** Recovers the question from a starter message made by formatQuestion. */
export function parseQuestion(content: string): string | undefined {
  const i = content.indexOf(QUESTION_PREFIX);
  if (i === -1) return undefined;
  const rest = content.slice(i + QUESTION_PREFIX.length).trim();
  return rest.endsWith(QUESTION_SUFFIX) ? rest.slice(0, -QUESTION_SUFFIX.length).trim() : rest;
}

const THREAD_NAME_MAX = 100;
const VARIANT_SEP = ' · ';

/** Thread names carry the variant so follow-ups survive bot restarts. */
export function threadName(question: string, variant: string): string {
  const suffix = `${VARIANT_SEP}${variant}`;
  const room = THREAD_NAME_MAX - suffix.length;
  const q = question.replace(/\s+/g, ' ').trim();
  const title = q.length > room ? `${q.slice(0, room - 1)}…` : q;
  return `${title}${suffix}`;
}

export function variantFromThreadName(name: string): string | undefined {
  const i = name.lastIndexOf(VARIANT_SEP);
  return i === -1 ? undefined : name.slice(i + VARIANT_SEP.length).trim() || undefined;
}

const quote = (s: unknown) => `“${String(s).slice(0, 60)}”`;

/** Progress lines for the agent's phases (planning and review wrap the research). */
export const PHASE_STEPS: Partial<Record<string, string>> = {
  planning: 'Calculating optimal assimilation vectors',
  reviewing: 'Verifying conformity with the source',
};

/** A player-friendly description of a research step, e.g. Scanning the rules for “tactics”. */
export function describeToolCall(name: string, rawArgs: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = (JSON.parse(rawArgs) as Record<string, unknown>) ?? {};
  } catch {
    // Show the step without details.
  }
  switch (name) {
    case 'search_rules':
      return `Scanning the rules for ${quote(a.pattern)}`;
    case 'read_rules':
      return a.section
        ? `Assimilating rules: ${quote(a.section)}`
        : a.start_line
          ? 'Assimilating rules'
          : 'Assimilating the rules’ table of contents';
    case 'search_code':
      return `Scanning the code for ${quote(a.pattern)}`;
    case 'read_file':
      return `Assimilating \`${String(a.path)}\``;
    case 'list_dir':
      return `Surveying \`${String(a.path ?? '.')}\``;
    case 'find_definition': {
      const q = Array.isArray(a.queries) ? a.queries.map(String) : [];
      const shown = q.slice(0, 3).join(', ') + (q.length > 3 ? ` and ${q.length - 3} more` : '');
      return `Retrieving ${shown || 'game data'} from the hive`;
    }
    default:
      return `Engaging ${name}`;
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const PROGRESS_PREFIX = '🟩 Assimilating knowledge';
const QUEUED_PREFIX = '⏳ Your query is queued';

/**
 * Starts of progressMessage output, so history.ts can skip status messages.
 * The older prefixes keep threads from before the rename working.
 */
export const STATUS_PREFIXES = [PROGRESS_PREFIX, QUEUED_PREFIX, '🔎 Researching', '⏳ Waiting'];

/** The status message shown while a question is being researched. */
export function progressMessage(steps: string[], elapsedMs: number, queued = 0): string {
  if (steps.length === 0 && queued > 0) {
    return `${QUEUED_PREFIX}. ${queued} drone${queued === 1 ? '' : 's'} ahead of you…`;
  }
  const recent = steps.slice(-5).map((s) => `-# ${s}`);
  const earlier = steps.length > 5 ? [`-# … ${steps.length - 5} earlier steps`] : [];
  return [`${PROGRESS_PREFIX}… (${formatElapsed(elapsedMs)})`, ...earlier, ...recent].join('\n');
}

/** Release notes longer than this are cut, with a link to the full text. */
const RELEASE_NOTES_MAX = 1400;

/** The /latest-release reply: version, date, links and release notes. */
export function formatRelease(
  release: { tag: string; name: string; url: string; publishedAt: string | null; notes: string },
  hud: { repo: string; siteUrl: string },
): string {
  const project = hud.repo.split('/')[1] ?? hud.repo;
  const version = release.name.includes(release.tag)
    ? release.name
    : `${release.name} (${release.tag})`;
  const when = release.publishedAt
    ? ` · released <t:${Math.floor(Date.parse(release.publishedAt) / 1000)}:D>`
    : '';
  let notes = release.notes
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Discord renders neither underlined (setext) headings nor levels below ###.
    .replace(/^([^\n#][^\n]*)\n=+[ \t]*$/gm, '## $1')
    .replace(/^([^\n#-][^\n]*)\n-{3,}[ \t]*$/gm, '### $1')
    .replace(/^#{4,}[ \t]/gm, '### ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (notes.length > RELEASE_NOTES_MAX) {
    const cut = notes.lastIndexOf('\n', RELEASE_NOTES_MAX);
    notes = `${notes.slice(0, cut > RELEASE_NOTES_MAX / 2 ? cut : RELEASE_NOTES_MAX).trimEnd()}\n… [full release notes](<${release.url}>)`;
  }
  return [
    `The latest assimilation of **${project}**: **${version}**${when}`,
    `Release: <${release.url}>`,
    `${project}: <${hud.siteUrl}>`,
    '',
    notes || '*No release notes were transmitted.*',
  ].join('\n');
}
