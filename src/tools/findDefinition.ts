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

const MAX_MATCHES = 5;
const OUTPUT_BUDGET = 8000;

interface Cached {
  mtimeMs: number;
  tables: Table[];
}
const cache = new Map<string, Cached>();

async function loadTables(root: string): Promise<Table[]> {
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

function numbered(entry: TableEntry): string {
  const indent = new RegExp(`^\\s{0,${entry.column}}`);
  return entry.text
    .split('\n')
    .map((l, i) => `${entry.startLine + i}| ${i === 0 ? l : l.replace(indent, '')}`)
    .join('\n');
}

const lineRange = (e: TableEntry) =>
  e.startLine === e.endLine ? `${e.startLine}` : `${e.startLine}-${e.endLine}`;

export const findDefinition = defineTool({
  name: 'find_definition',
  description:
    'Look up the data-table entry for an item, skill, building/ship (object), terrain, weapon, armor, ' +
    'monster etc. in gamedata.cpp by name, abbreviation or enum constant (e.g. "plate armor", "PARM", ' +
    '"TACT", "I_PLATEARMOR"). Returns the entry with line numbers and the field legend. ' +
    'These are the base values; a variant may change them in <variant>/extra.cpp.',
  schema: z.object({
    query: z.string().min(1).describe('Name, abbreviation or enum constant'),
    table: z.string().optional().describe('Restrict to one table, e.g. "SkillDefs" or "ItemDefs"'),
  }),
  async handler(args, ctx) {
    const tables = await loadTables(await realpath(ctx.root));
    const q = args.query.trim().toLowerCase();
    const wanted = args.table?.toLowerCase();
    const selected = wanted ? tables.filter((t) => t.name.toLowerCase() === wanted) : tables;
    if (selected.length === 0) {
      throw new ToolError(
        `Unknown table "${args.table}". Tables: ${tables.map((t) => t.name).join(', ')}`,
      );
    }

    const matches = selected.flatMap((t) =>
      t.entries
        .filter(
          (e) => e.strings.some((s) => s.toLowerCase() === q) || e.enumName?.toLowerCase() === q,
        )
        .map((e) => ({ table: t, entry: e })),
    );

    if (matches.length === 0) {
      const similar = selected
        .flatMap((t) => t.entries.map((e) => ({ t, e })))
        .filter(({ e }) => e.strings.some((s) => s.toLowerCase().includes(q)))
        .slice(0, 10)
        .map(({ t, e }) => `${e.strings[0]} (${t.name})`);
      return similar.length > 0
        ? `No exact match for "${args.query}". Similar entries: ${similar.join(', ')}`
        : `No entry matches "${args.query}". Try search_code.`;
    }

    const shownLegends = new Set<string>();
    const parts = matches.slice(0, MAX_MATCHES).map(({ table, entry }) => {
      const header =
        `${table.name}[${entry.index}]` +
        (entry.enumName ? ` (enum ${entry.enumName})` : '') +
        ` — gamedata.cpp:${lineRange(entry)}`;
      let legend = '';
      if (!shownLegends.has(table.name) && table.legend.length > 0) {
        shownLegends.add(table.name);
        legend = `Field order (from gamedata.cpp comments):\n${table.legend.join('\n')}\n`;
      }
      return `${header}\n${legend}${numbered(entry)}`;
    });

    const enumNames = matches.map((m) => m.entry.enumName).filter(Boolean);
    const hint =
      enumNames.length > 0
        ? `\nTo see variant changes, search for ${[...new Set(enumNames)].join(', ')} in */extra.cpp.`
        : '';
    const more =
      matches.length > MAX_MATCHES
        ? `\n[${matches.length - MAX_MATCHES} more matches not shown]`
        : '';
    return truncate(parts.join('\n\n') + more + hint, OUTPUT_BUDGET);
  },
});
