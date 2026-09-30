/**
 * Remembers successful tool calls within one question so repeats can be
 * answered with a pointer to the earlier result instead of the full output.
 * Small models otherwise re-read the same file ranges and redo lookups until
 * their context and budget run out.
 */

/** Tools whose calls read a line range: [start default, window size when end is omitted]. */
const RANGE_TOOLS: Record<string, { key: (a: Record<string, unknown>) => string; window: number }> =
  {
    read_file: { key: (a) => `file:${String(a.path).replace(/^\.\//, '')}`, window: 150 },
    read_rules: { key: (a) => `rules:${String(a.variant ?? '')}`, window: 100 },
  };

interface Range {
  start: number;
  end: number;
  step: number;
}

function parse(rawArgs: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Stable key: same tool and same arguments regardless of key order or case of strings. */
function canonical(name: string, args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.trim().toLowerCase()
      : Array.isArray(v)
        ? v.map(norm)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([, x]) => x !== undefined && x !== null)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, norm(x)]),
            )
          : v;
  return `${name}:${JSON.stringify(norm(args))}`;
}

export class CallMemory {
  private readonly exact = new Map<string, number>();
  private readonly ranges = new Map<string, Range[]>();

  /** The step number of an earlier call that already produced this result, if any. */
  earlier(name: string, rawArgs: string): number | undefined {
    const args = parse(rawArgs);
    if (!args) return undefined;
    const hit = this.exact.get(canonical(name, args));
    if (hit !== undefined) return hit;

    const range = this.rangeOf(name, args);
    if (!range) return undefined;
    return this.ranges.get(range.key)?.find((r) => r.start <= range.start && range.end <= r.end)
      ?.step;
  }

  remember(name: string, rawArgs: string, step: number): void {
    const args = parse(rawArgs);
    if (!args) return;
    this.exact.set(canonical(name, args), step);
    const range = this.rangeOf(name, args);
    if (range) {
      const list = this.ranges.get(range.key) ?? [];
      list.push({ start: range.start, end: range.end, step });
      this.ranges.set(range.key, list);
    }
  }

  private rangeOf(name: string, args: Record<string, unknown>) {
    const tool = RANGE_TOOLS[name];
    // Only explicit line reads; read_rules by section is covered by the exact match.
    if (!tool || typeof args.start_line !== 'number' || args.section) return undefined;
    const start = args.start_line;
    const end = typeof args.end_line === 'number' ? args.end_line : start + tool.window - 1;
    return { key: tool.key(args), start, end };
  }
}

export const repeatNote = (name: string, step: number) =>
  `Already shown: this ${name} request is covered by the result of step ${step}. ` +
  'Use that result instead of requesting it again, or ask for something new.';
