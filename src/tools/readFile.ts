import { readFile as fsReadFile, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInRepo, toRepoRelative } from '../repo/paths.js';
import { defineTool, ToolError } from './types.js';

const DEFAULT_LINES = 150;
const MAX_LINES = 300;
const MAX_LINE_LENGTH = 400;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const readFile = defineTool({
  name: 'read_file',
  description:
    `Read lines from a file in the game repository. Lines are numbered (1-based). ` +
    `At most ${MAX_LINES} lines per call; read further ranges with more calls.`,
  schema: z.object({
    path: z
      .string()
      .min(1)
      .describe('File path relative to the repo root, e.g. "standard/rules.cpp"'),
    start_line: z.number().int().min(1).optional().describe('First line to read (default 1)'),
    end_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Last line to read (default start_line + ${DEFAULT_LINES - 1})`),
  }),
  async handler(args, ctx) {
    const rootReal = await realpath(ctx.root);
    const abs = await resolveInRepo(rootReal, args.path);
    const rel = toRepoRelative(rootReal, abs);
    const info = await stat(abs);
    if (info.isDirectory()) throw new ToolError(`${rel} is a directory; use list_dir.`);
    if (info.size > MAX_FILE_BYTES)
      throw new ToolError(`${rel} is too large to read; use search_code.`);

    const content = await fsReadFile(abs, 'utf8');
    if (content.includes('\u0000')) throw new ToolError(`${rel} is a binary file.`);
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();

    const start = args.start_line ?? 1;
    if (start > lines.length) {
      throw new ToolError(`${rel} has only ${lines.length} lines.`);
    }
    const requestedEnd = args.end_line ?? start + DEFAULT_LINES - 1;
    if (requestedEnd < start) throw new ToolError('end_line must be >= start_line.');
    const end = Math.min(requestedEnd, start + MAX_LINES - 1, lines.length);

    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => {
        const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
        return `${String(start + i).padStart(width)}| ${text}`;
      })
      .join('\n');
    const more = end < lines.length ? ` — continue with start_line ${end + 1}` : '';
    return `${rel} (lines ${start}-${end} of ${lines.length}${more})\n${body}`;
  },
});
