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
const QUESTION_SUFFIX = '[Accessing collective hive mind ... ]';

/** The /ask reply that becomes the thread's starter message. */
export function formatQuestion(userId: string, question: string): string {
  return `We are Borg!\n<@${userId}> asked:\n${QUESTION_PREFIX}${question}\n${QUESTION_SUFFIX}`;
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
  planning: 'Planning the research',
  reviewing: 'Checking the answer against the sources',
};

/** A player-friendly description of a research step, e.g. Searching the rules for “tactics”. */
export function describeToolCall(name: string, rawArgs: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = (JSON.parse(rawArgs) as Record<string, unknown>) ?? {};
  } catch {
    // Show the step without details.
  }
  switch (name) {
    case 'search_rules':
      return `Searching the rules for ${quote(a.pattern)}`;
    case 'read_rules':
      return a.section
        ? `Reading the rules: ${quote(a.section)}`
        : a.start_line
          ? 'Reading the rules'
          : 'Reading the rules’ table of contents';
    case 'search_code':
      return `Searching the code for ${quote(a.pattern)}`;
    case 'read_file':
      return `Reading \`${String(a.path)}\``;
    case 'list_dir':
      return `Browsing \`${String(a.path ?? '.')}\``;
    case 'find_definition': {
      const q = Array.isArray(a.queries) ? a.queries.map(String) : [];
      const shown = q.slice(0, 3).join(', ') + (q.length > 3 ? ` and ${q.length - 3} more` : '');
      return `Looking up ${shown || 'game data'}`;
    }
    default:
      return `Using ${name}`;
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The status message shown while a question is being researched. */
export function progressMessage(steps: string[], elapsedMs: number, queued = 0): string {
  if (steps.length === 0 && queued > 0) {
    return `⏳ Waiting for ${queued} question${queued === 1 ? '' : 's'} ahead of yours…`;
  }
  const recent = steps.slice(-5).map((s) => `-# ${s}`);
  const earlier = steps.length > 5 ? [`-# … ${steps.length - 5} earlier steps`] : [];
  return [`🔎 Researching… (${formatElapsed(elapsedMs)})`, ...earlier, ...recent].join('\n');
}
