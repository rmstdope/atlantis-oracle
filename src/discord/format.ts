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
  return `-# ${info.model} · ${info.variant} · ${repo}@${info.commit.slice(0, 7)} · AI answer, may be wrong: check the cited sources`;
}

const QUESTION_PREFIX = '**Question:** ';

/** The /ask reply that becomes the thread's starter message. */
export function formatQuestion(userId: string, question: string): string {
  return `<@${userId}> asked:\n${QUESTION_PREFIX}${question}`;
}

/** Recovers the question from a starter message made by formatQuestion. */
export function parseQuestion(content: string): string | undefined {
  const i = content.indexOf(QUESTION_PREFIX);
  return i === -1 ? undefined : content.slice(i + QUESTION_PREFIX.length).trim();
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
