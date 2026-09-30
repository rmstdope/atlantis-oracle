import { z } from 'zod';
import type { Heading } from '../rules/markdown.js';
import type { RulesDoc } from '../rules/store.js';
import { defineTool, ToolError, truncate, type ToolContext } from './types.js';

const SEARCH_BUDGET = 6000;
const READ_BUDGET = 12000;
const MAX_MATCHES = 40;
const SNIPPET_RADIUS = 160;

const variantArg = z
  .string()
  .optional()
  .describe('Game variant; defaults to the variant of the question. Use it to compare variants.');

function rulesFor(ctx: ToolContext, requested?: string): RulesDoc {
  const variant = requested?.trim() || ctx.variant;
  const doc = ctx.rules?.get(variant);
  if (!doc) {
    const available = ctx.rules?.variants.join(', ') || 'none';
    throw new ToolError(
      `No rules available for "${variant}" (available: ${available}). Research the code instead.`,
    );
  }
  return doc;
}

/** Heading trail for a line, e.g. "Skills > Studying". */
function sectionOf(headings: Heading[], line: number): string {
  const trail: Heading[] = [];
  for (const h of headings) {
    if (h.line > line) break;
    while (trail.length > 0 && trail.at(-1)!.level >= h.level) trail.pop();
    trail.push(h);
  }
  return trail.map((h) => h.text).join(' > ') || '(top)';
}

function snippet(text: string, index: number, length: number): string {
  if (text.length <= SNIPPET_RADIUS * 2) return text;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

const literal = (pattern: string) =>
  new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/** The pattern as a regex, plus a literal fallback when it contains regex syntax. */
function patterns(pattern: string): RegExp[] {
  try {
    const re = new RegExp(pattern, 'i');
    return /[.*+?^${}()|[\]\\]/.test(pattern) ? [re, literal(pattern)] : [re];
  } catch {
    return [literal(pattern)];
  }
}

function search(
  doc: RulesDoc,
  re: RegExp,
): { line: number; text: string; index: number; length: number }[] {
  const found = [];
  for (const [i, text] of doc.lines.entries()) {
    const m = re.exec(text);
    if (m) found.push({ line: i + 1, text, index: m.index, length: m[0].length });
  }
  return found;
}

export const searchRules = defineTool({
  name: 'search_rules',
  description:
    'Search the player rules of the game (generated from the game code) for a word, phrase or ' +
    'regular expression, case-insensitive. Returns matching lines with their line number and the ' +
    'section they belong to. Start every question here.',
  schema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe('Text or regular expression, e.g. "tactics" or "free round"'),
    variant: variantArg,
  }),
  async handler(args, ctx) {
    const doc = rulesFor(ctx, args.variant);
    let found: ReturnType<typeof search> = [];
    for (const re of patterns(args.pattern)) {
      found = search(doc, re);
      if (found.length > 0) break;
    }
    const total = found.length;
    const hits: string[] = [];
    let lastSection = '';
    for (const f of found.slice(0, MAX_MATCHES)) {
      const section = sectionOf(doc.headings, f.line);
      if (section !== lastSection) {
        hits.push(`§ ${section}`);
        lastSection = section;
      }
      hits.push(`  ${f.line}: ${snippet(f.text, f.index, f.length)}`);
    }
    if (total === 0)
      return `No matches for ${JSON.stringify(args.pattern)} in the ${doc.variant} rules.`;
    const more =
      total > MAX_MATCHES
        ? `\n[${total - MAX_MATCHES} more matches not shown; use a more specific pattern]`
        : '';
    return truncate(
      `${total} matches in the ${doc.variant} rules:\n${hits.join('\n')}${more}`,
      SEARCH_BUDGET,
      'use a more specific pattern',
    );
  },
});

function outline(doc: RulesDoc): string {
  const body = doc.headings
    .filter((h) => h.level <= 3)
    .map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}${h.line}: ${h.text}`)
    .join('\n');
  return `Sections of the ${doc.variant} rules (${doc.lines.length} lines; read one with the "section" argument):\n${body}`;
}

/**
 * Finds a section by heading. Accepts a plain heading ("Studying") or a
 * trail as printed by search_rules ("Skills > Studying").
 */
function findSection(doc: RulesDoc, name: string): Heading | undefined {
  const norm = (t: string) => t.trim().toLowerCase().replace(/:$/, '');
  const parts = name.split('>').map(norm).filter(Boolean);
  const last = parts.at(-1);
  if (!last) return undefined;
  const trail = (h: Heading) => sectionOf(doc.headings, h.line).toLowerCase();
  const candidates = [
    (h: Heading) => norm(h.text) === last,
    (h: Heading) => norm(h.text).startsWith(last),
    (h: Heading) => norm(h.text).includes(last),
  ];
  for (const test of candidates) {
    const hits = doc.headings.filter(test);
    // With a trail, prefer the heading whose ancestors match it too.
    const inTrail = hits.find((h) => parts.every((p) => trail(h).includes(p)));
    if (inTrail ?? hits[0]) return inTrail ?? hits[0];
  }
  return undefined;
}

function numbered(doc: RulesDoc, start: number, end: number): string {
  return doc.lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}| ${l}`)
    .join('\n');
}

export const readRules = defineTool({
  name: 'read_rules',
  description:
    'Read the player rules. Without arguments it returns the table of contents with line numbers. ' +
    'With "section" it returns that section (e.g. "Tactics", "Faction Points", "STUDY"). ' +
    'With start_line/end_line it returns those lines.',
  schema: z.object({
    section: z.string().optional().describe('Section heading to read, matched case-insensitively'),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
    variant: variantArg,
  }),
  async handler(args, ctx) {
    const doc = rulesFor(ctx, args.variant);
    const source = `${doc.variant} rules`;

    if (args.section) {
      const h = findSection(doc, args.section);
      if (!h) {
        throw new ToolError(
          `No section matching "${args.section}". Call read_rules without arguments for the table of contents, or use search_rules.`,
        );
      }
      const next = doc.headings.find((o) => o.line > h.line && o.level <= h.level);
      const end = (next?.line ?? doc.lines.length + 1) - 1;
      return truncate(
        `${source} § ${sectionOf(doc.headings, h.line)} (lines ${h.line}-${end})\n${numbered(doc, h.line, end)}`,
        READ_BUDGET,
        `continue with start_line/end_line`,
      );
    }

    if (args.start_line) {
      const start = args.start_line;
      if (start > doc.lines.length)
        throw new ToolError(`The ${source} have only ${doc.lines.length} lines.`);
      const end = Math.min(args.end_line ?? start + 99, start + 299, doc.lines.length);
      if (end < start) throw new ToolError('end_line must be >= start_line.');
      return truncate(
        `${source}, § ${sectionOf(doc.headings, start)} (lines ${start}-${end} of ${doc.lines.length})\n${numbered(doc, start, end)}`,
        READ_BUDGET,
        'read a smaller range',
      );
    }

    return truncate(outline(doc), READ_BUDGET, 'use search_rules to find sections');
  },
});
