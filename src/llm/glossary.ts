import { loadTables } from '../tools/findDefinition.js';

export interface GlossaryEntry {
  abbr: string;
  kind: 'item' | 'skill';
  name: string;
}

/** Where each table keeps its abbreviation among the entry's string literals. */
const ABBR_POSITION: Record<string, { kind: GlossaryEntry['kind']; index: number }> = {
  ItemDefs: { kind: 'item', index: 2 }, // name, plural, abbr
  SkillDefs: { kind: 'skill', index: 1 }, // name, abbr
};

/**
 * Finds game abbreviations in a question (players write e.g. "SSTO" for summon
 * storm) so the model can search for the full names, which the rules use.
 * Only all-caps tokens are considered, so ordinary words never match.
 */
export async function findAbbreviations(root: string, text: string): Promise<GlossaryEntry[]> {
  const tokens = new Set(text.match(/\b[A-Z][A-Z0-9]{2,4}\b/g) ?? []);
  if (tokens.size === 0) return [];
  let tables;
  try {
    tables = await loadTables(root);
  } catch {
    return []; // Different repo layout: no glossary.
  }
  const found: GlossaryEntry[] = [];
  for (const table of tables) {
    const pos = ABBR_POSITION[table.name];
    if (!pos) continue;
    for (const entry of table.entries) {
      const abbr = entry.strings[pos.index];
      if (abbr && tokens.has(abbr) && !found.some((f) => f.abbr === abbr && f.kind === pos.kind)) {
        found.push({ abbr, kind: pos.kind, name: entry.strings[0]! });
      }
    }
  }
  return found;
}

export function glossaryNote(entries: GlossaryEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const items = entries.map((e) => `${e.abbr} = ${e.kind} "${e.name}"`);
  return `Game abbreviations in the question: ${items.join('; ')}. The rules use the full names.`;
}
