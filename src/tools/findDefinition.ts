import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  attachEnumNames,
  parseEnums,
  parseGamedata,
  type Table,
  type TableEntry,
} from './gamedata.js';
import { defineTool, ToolError, truncate } from './types.js';

const MAX_QUERIES = 25;
/** Up to this many matches are shown in full; beyond that, one summary line each. */
const FULL_ENTRIES = 4;
const MAX_MATCHES = 40;
const OUTPUT_BUDGET = 10000;

interface Cached {
  mtimeMs: number;
  tables: Table[];
}
const cache = new Map<string, Cached>();

/** Parsed gamedata.cpp tables with enum names, cached per repo root and file mtime. */
export async function loadTables(root: string): Promise<Table[]> {
  const cppPath = path.join(root, 'gamedata.cpp');
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(cppPath)).mtimeMs;
  } catch {
    throw new ToolError(
      'gamedata.cpp was not found at the repo root; this repository may use a different layout. Use search_code instead.',
    );
  }
  const cached = cache.get(root);
  if (cached && cached.mtimeMs === mtimeMs) return cached.tables;

  const tables = parseGamedata(await readFile(cppPath, 'utf8'));
  try {
    attachEnumNames(tables, parseEnums(await readFile(path.join(root, 'gamedata.h'), 'utf8')));
  } catch {
    // Enum names are a convenience; carry on without them.
  }
  cache.set(root, { mtimeMs, tables });
  return tables;
}

/** Lines in the variant's extra.cpp that mention an enum constant, e.g. EnableItem(I_PICK). */
async function variantChanges(root: string, variant: string): Promise<Map<string, string[]>> {
  const file = path.join(variant, 'extra.cpp');
  let lines: string[];
  try {
    lines = (await readFile(path.join(root, file), 'utf8')).split('\n');
  } catch {
    return new Map();
  }
  const refs = new Map<string, string[]>();
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/\b([ISOR]_[A-Z0-9_]+)\b/g)) {
      const list = refs.get(m[1]!) ?? [];
      list.push(`${file}:${i + 1}: ${line.trim()}`);
      refs.set(m[1]!, list);
    }
  });
  return refs;
}

function numbered(entry: TableEntry): string {
  const indent = new RegExp(`^\\s{0,${entry.column}}`);
  return entry.text
    .split('\n')
    .map((l, i) => `${entry.startLine + i}| ${i === 0 ? l : l.replace(indent, '')}`)
    .join('\n');
}

const lineRange = (e: TableEntry) =>
  e.startLine === e.endLine ? `${e.startLine}` : `${e.startLine}-${e.endLine}`;

const isDisabled = (e: TableEntry) => /\b\w+::DISABLED\b/.test(e.text);

function matches(entry: TableEntry, q: string): boolean {
  return entry.strings.some((s) => s.toLowerCase() === q) || entry.enumName?.toLowerCase() === q;
}

export const findDefinition = defineTool({
  name: 'find_definition',
  description:
    'Look up data-table entries for items, skills, buildings/ships (objects), terrain, weapons, armor, ' +
    'monsters etc. in gamedata.cpp by name, abbreviation or enum constant (e.g. "plate armor", "PARM", ' +
    '"TACT", "I_PLATEARMOR"). Pass several names at once to look them up together. Shows whether each ' +
    "entry is disabled by default and which lines in the variant's extra.cpp change it.",
  schema: z.object({
    queries: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_QUERIES)
      .describe('One or more names, abbreviations or enum constants'),
    table: z.string().optional().describe('Restrict to one table, e.g. "SkillDefs" or "ItemDefs"'),
  }),
  async handler(args, ctx) {
    const root = await realpath(ctx.root);
    const tables = await loadTables(root);
    const wanted = args.table?.toLowerCase();
    const selected = wanted ? tables.filter((t) => t.name.toLowerCase() === wanted) : tables;
    if (selected.length === 0) {
      throw new ToolError(
        `Unknown table "${args.table}". Tables: ${tables.map((t) => t.name).join(', ')}`,
      );
    }
    const changes = await variantChanges(root, ctx.variant);

    const found: { table: Table; entry: TableEntry }[] = [];
    const notes: string[] = [];
    for (const raw of args.queries) {
      const q = raw.trim().toLowerCase();
      const hits = selected.flatMap((t) =>
        t.entries.filter((e) => matches(e, q)).map((e) => ({ table: t, entry: e })),
      );
      if (hits.length > 0) {
        for (const h of hits) if (!found.some((f) => f.entry === h.entry)) found.push(h);
        continue;
      }
      const similar = selected
        .flatMap((t) => t.entries.map((e) => `${e.strings[0]} (${t.name})`))
        .filter((s) => s.toLowerCase().includes(q))
        .slice(0, 8);
      notes.push(
        similar.length > 0
          ? `No exact match for "${raw}". Similar: ${similar.join(', ')}`
          : `No entry matches "${raw}".`,
      );
    }

    const full = found.length <= FULL_ENTRIES;
    const shownLegends = new Set<string>();
    const parts = found.slice(0, MAX_MATCHES).map(({ table, entry }) => {
      const status = isDisabled(entry) ? 'disabled by default' : 'enabled by default';
      const header =
        `${table.name}[${entry.index}]` +
        (entry.enumName ? ` ${entry.enumName}` : '') +
        ` — gamedata.cpp:${lineRange(entry)} — ${status}`;
      const variantLines = entry.enumName ? (changes.get(entry.enumName) ?? []) : [];
      const variantNote =
        variantLines.length > 0
          ? `\n  ${ctx.variant} changes it:\n${variantLines.map((l) => `    ${l}`).join('\n')}`
          : entry.enumName
            ? `\n  not mentioned in ${ctx.variant}/extra.cpp`
            : '';
      if (!full) return `${header}\n  ${entry.text.split('\n')[0]!.trim()}${variantNote}`;

      let legend = '';
      if (!shownLegends.has(table.name) && table.legend.length > 0) {
        shownLegends.add(table.name);
        legend = `Field order (from gamedata.cpp comments):\n${table.legend.join('\n')}\n`;
      }
      return `${header}${variantNote}\n${legend}${numbered(entry)}`;
    });

    if (!full) parts.unshift('Summary view; look up fewer names at once to see full entries.');
    if (found.length > MAX_MATCHES)
      parts.push(`[${found.length - MAX_MATCHES} more matches not shown]`);
    if (parts.length === 0) return notes.join('\n') + '\nTry search_code.';
    return truncate(
      [...parts, ...notes].join('\n\n'),
      OUTPUT_BUDGET,
      'look up fewer names at once',
    );
  },
});
