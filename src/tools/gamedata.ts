/**
 * Parser for the data tables in Atlantis' gamedata.cpp, e.g.
 * `std::vector<SkillType> SkillDefs = { {...}, {...} };`
 */

export interface TableEntry {
  index: number;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Column of the opening brace, for dedenting continuation lines. */
  column: number;
  text: string;
  /** All string literals in the entry, e.g. name, plural, abbreviation. */
  strings: string[];
  /** Enum constant from gamedata.h for this index, e.g. I_PLATEARMOR. */
  enumName?: string;
}

export interface Table {
  name: string;
  type: string;
  line: number;
  /** Field legend from the comments above/at the start of the table. */
  legend: string[];
  entries: TableEntry[];
}

/**
 * Table declarations in the two styles found in Atlantis branches:
 * `std::vector<ItemType> ItemDefs = {` (master) and `static ItemType id[] = {`
 * followed by `ItemType *ItemDefs = id;` (stable).
 */
const TABLE_RE = /std::vector<(\w+)>\s+(\w+)\s*=|^(?:static\s+)?(\w+Type)\s+(\w+)\s*\[\s*\]\s*=/gm;
const ALIAS_RE = /^(?:\w+Type)\s*\*\s*(\w+Defs)\s*=\s*(\w+)\s*;/gm;

/** Tables whose index order matches an enum in gamedata.h, keyed by enum prefix. */
const ENUM_PREFIX_TO_TABLE: Record<string, string> = {
  I_: 'ItemDefs',
  S_: 'SkillDefs',
  O_: 'ObjectDefs',
  R_: 'TerrainDefs',
};

function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Scans from `from` (which must be at or before the table's opening brace) and
 * returns top-level entries as [start, end) offsets, skipping comments and literals.
 */
function scanEntries(
  src: string,
  from: number,
): { entries: [number, number][]; bodyStart: number } {
  const entries: [number, number][] = [];
  let depth = 0;
  let entryStart = -1;
  let bodyStart = -1;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
    } else if (c === '/' && next === '*') {
      const endC = src.indexOf('*/', i + 2);
      i = endC === -1 ? src.length : endC + 1;
    } else if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '{') {
      depth++;
      if (depth === 1) bodyStart = i + 1;
      if (depth === 2) entryStart = i;
    } else if (c === '}') {
      if (depth === 2) entries.push([entryStart, i + 1]);
      depth--;
      if (depth === 0) break;
    } else if (c === ';' && depth === 0) {
      break;
    }
  }
  return { entries, bodyStart };
}

function legendAbove(lines: string[], tableLine: number): string[] {
  const legend: string[] = [];
  let blanks = 0;
  for (let i = tableLine - 2; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (l === '') {
      if (legend.length > 0 || ++blanks > 2) break;
      continue;
    }
    if (!l.startsWith('//')) break;
    legend.unshift(l);
  }
  return legend;
}

export function parseGamedata(src: string): Table[] {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lines = src.split('\n');

  const aliases = new Map<string, string>();
  for (const a of src.matchAll(ALIAS_RE)) aliases.set(a[2]!, a[1]!);

  const tables: Table[] = [];
  for (const m of src.matchAll(TABLE_RE)) {
    const type = (m[1] ?? m[3])!;
    const variable = (m[2] ?? m[4])!;
    const name = aliases.get(variable) ?? variable;
    if (!name.endsWith('Defs')) continue;
    const line = lineAt(lineStarts, m.index);
    const { entries, bodyStart } = scanEntries(src, m.index + m[0].length);

    // Comments inside the table before the first entry also describe fields (e.g. ObjectDefs).
    // Only field lists (with commas) count; others annotate the first entry.
    const firstEntry = entries[0]?.[0] ?? bodyStart;
    const inner = bodyStart >= 0 ? src.slice(bodyStart, firstEntry) : '';
    const innerLegend = inner
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('//') && l.includes(','));
    const legend = [...legendAbove(lines, line), ...innerLegend]
      .filter((l) => l !== '//')
      .slice(0, 25);

    tables.push({
      name,
      type,
      line,
      legend,
      entries: entries.map(([s, e], index) => {
        const text = src.slice(s, e);
        const startLine = lineAt(lineStarts, s);
        return {
          index,
          startLine,
          column: s - lineStarts[startLine - 1]!,
          endLine: lineAt(lineStarts, e - 1),
          text,
          strings: [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((sm) => sm[1]!),
        };
      }),
    });
  }
  return tables;
}

/** Parses the anonymous enums in gamedata.h into member lists, keyed by table name. */
export function parseEnums(header: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const stripped = header.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const m of stripped.matchAll(/enum\s*(?:class\s+)?\w*\s*\{([^}]*)\}/g)) {
    const members = m[1]!
      .split(',')
      .map((s) => s.trim().split(/\s*=/)[0]!.trim())
      .filter((s) => /^[A-Z_][A-Z0-9_]*$/.test(s));
    const first = members[0];
    if (!first) continue;
    const prefix = first.slice(0, first.indexOf('_') + 1);
    const table = ENUM_PREFIX_TO_TABLE[prefix];
    if (!table || result.has(table)) continue;
    // Drop the trailing count member (NITEMS, NSKILLS, R_NUM, ...).
    const last = members.at(-1)!;
    if (!last.startsWith(prefix) || last === `${prefix}NUM`) members.pop();
    result.set(table, members);
  }
  return result;
}

/** Attaches enum names to entries when the counts line up exactly. */
export function attachEnumNames(tables: Table[], enums: Map<string, string[]>): void {
  for (const t of tables) {
    const names = enums.get(t.name);
    if (!names || names.length !== t.entries.length) continue;
    t.entries.forEach((e, i) => (e.enumName = names[i]));
  }
}
