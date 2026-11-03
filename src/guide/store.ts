import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { PathError, resolveInRepo } from '../repo/paths.js';
import type { GameRepo } from '../repo/sync.js';

/**
 * The code guide: a hand-written Markdown map from player topics to the
 * functions, tables and constants that decide them. Entries name symbols,
 * not line numbers; `resolveGuide` turns them into `path:line` against the
 * current checkout, so the pointers stay exact across syncs and stale
 * entries are reported instead of silently misleading the model.
 *
 * Format (one topic per `##` heading):
 *
 *   ## Combat: hit odds
 *   One to three sentences on how the mechanic flows through the code.
 *   - `Army::DoAnAttack` (army.cpp): one attack: target, hit roll, armor save.
 */
export interface GuideEntry {
  symbol: string;
  path: string;
  note: string;
}

export interface GuideTopic {
  title: string;
  intro: string;
  entries: GuideEntry[];
}

export interface ResolvedEntry extends GuideEntry {
  /** 1-based line of the symbol's definition (or first mention); absent when not found. */
  line?: number;
}

export interface ResolvedTopic extends GuideTopic {
  entries: ResolvedEntry[];
}

export interface ResolvedGuide {
  commit: string;
  topics: ResolvedTopic[];
  /** Entries whose file or symbol is missing in this commit, as "topic: symbol (path)". */
  unresolved: string[];
}

const ENTRY = /^- `([^`]+)` \(([^)\s]+)\): (.+)$/;

export function parseGuide(markdown: string): { topics: GuideTopic[]; warnings: string[] } {
  const topics: GuideTopic[] = [];
  const warnings: string[] = [];
  let current: GuideTopic | undefined;
  const intro: string[] = [];
  const flush = () => {
    if (current) current.intro = intro.join(' ').trim();
    intro.length = 0;
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      flush();
      current = { title: line.slice(3).trim(), intro: '', entries: [] };
      topics.push(current);
      continue;
    }
    if (!current || line.trim() === '' || line.startsWith('# ')) continue;
    const m = ENTRY.exec(line);
    if (m) {
      current.entries.push({ symbol: m[1]!, path: m[2]!, note: m[3]!.trim() });
    } else if (line.startsWith('- ')) {
      warnings.push(`${current.title}: unparsed entry "${line.slice(0, 60)}"`);
    } else {
      intro.push(line.trim());
    }
  }
  flush();
  for (const t of topics) {
    if (t.entries.length === 0) warnings.push(`${t.title}: no entries`);
  }
  return { topics, warnings };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds the line that defines `symbol` in `lines`. Prefers a definition at
 * column 0 (how Atlantis writes functions), then any mention. `Class::Method`
 * must be followed by `(`; plain identifiers match as whole words, which also
 * finds `// FIELD_NAME` comments in `<variant>/rules.cpp` initialisers.
 */
export function findSymbolLine(lines: string[], symbol: string): number | undefined {
  const sym = escapeRegex(symbol);
  const patterns = symbol.includes('::')
    ? [new RegExp(`^\\S.*(^|[^\\w:])${sym}\\s*\\(`), new RegExp(`(^|[^\\w:])${sym}\\s*\\(`)]
    : [
        new RegExp(`^\\S.*\\b${sym}\\s*[(=\\[{]`),
        new RegExp(`^\\S.*\\b${sym}\\b`),
        new RegExp(`\\b${sym}\\b`),
      ];
  for (const re of patterns) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return i + 1;
  }
  return undefined;
}

export async function resolveGuide(
  topics: GuideTopic[],
  root: string,
  commit: string,
): Promise<ResolvedGuide> {
  const files = new Map<string, Promise<string[] | undefined>>();
  const linesOf = (rel: string) => {
    let p = files.get(rel);
    if (!p) {
      p = resolveInRepo(root, rel)
        .then((abs) => readFile(abs, 'utf8'))
        .then((text) => text.split('\n'))
        .catch((err: unknown) => {
          if (err instanceof PathError || (err as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
          throw err;
        });
      files.set(rel, p);
    }
    return p;
  };

  const unresolved: string[] = [];
  const resolved: ResolvedTopic[] = [];
  for (const topic of topics) {
    const entries: ResolvedEntry[] = [];
    for (const e of topic.entries) {
      const lines = await linesOf(e.path);
      const line = lines ? findSymbolLine(lines, e.symbol) : undefined;
      if (line === undefined) unresolved.push(`${topic.title}: ${e.symbol} (${e.path})`);
      entries.push(line === undefined ? { ...e } : { ...e, line });
    }
    resolved.push({ ...topic, entries });
  }
  return { commit, topics: resolved, unresolved };
}

/** Renders one topic for the model: pointers first, then where to go next. */
export function formatTopic(topic: ResolvedTopic): string {
  const lines = topic.entries.map((e) =>
    e.line === undefined
      ? `- ${e.symbol} (${e.path}, not found in this commit; search_code for it): ${e.note}`
      : `- ${e.path}:${e.line} ${e.symbol}: ${e.note}`,
  );
  return `## ${topic.title}\n${topic.intro}\n${lines.join('\n')}\n\nRead the code at these lines with read_file (a definition starts there; read 40-80 lines).`;
}

/** Loads the guide file once and resolves it per repo commit. */
export class GuideStore {
  private topics: GuideTopic[] = [];
  private resolved: ResolvedGuide | undefined;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  get(): ResolvedGuide | undefined {
    return this.resolved;
  }

  /** Reads the guide (if present) and resolves it for the repo's current commit. */
  async prepare(repo: Pick<GameRepo, 'dir' | 'commit'>): Promise<void> {
    if (this.topics.length === 0) {
      let text: string;
      try {
        text = await readFile(path.resolve(this.file), 'utf8');
      } catch {
        this.logger.warn({ file: this.file }, 'No code guide found; guide lookup unavailable');
        return;
      }
      const parsed = parseGuide(text);
      this.topics = parsed.topics;
      for (const w of parsed.warnings) this.logger.warn({ file: this.file }, `Code guide: ${w}`);
    }
    if (this.resolved?.commit === repo.commit) return;
    this.resolved = await resolveGuide(this.topics, repo.dir, repo.commit);
    this.logger.info(
      {
        topics: this.resolved.topics.length,
        entries: this.resolved.topics.reduce((n, t) => n + t.entries.length, 0),
        unresolved: this.resolved.unresolved,
      },
      'Code guide resolved',
    );
  }
}
