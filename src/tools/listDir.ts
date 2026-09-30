import { readdir, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInRepo, toRepoRelative } from '../repo/paths.js';
import { defineTool, ToolError } from './types.js';

const MAX_ENTRIES = 200;

export const listDir = defineTool({
  name: 'list_dir',
  description:
    'List a directory in the game repository. Directories end with "/". Use it to get oriented.',
  schema: z.object({
    path: z.string().optional().describe('Directory relative to the repo root. Default: the root'),
  }),
  async handler(args, ctx) {
    const rootReal = await realpath(ctx.root);
    const abs = await resolveInRepo(rootReal, args.path ?? '.');
    const rel = toRepoRelative(rootReal, abs);
    if (!(await stat(abs)).isDirectory()) throw new ToolError(`${rel} is a file; use read_file.`);

    const entries = (await readdir(abs, { withFileTypes: true }))
      .filter((e) => e.name !== '.git')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
    const shown = entries.slice(0, MAX_ENTRIES);
    const more =
      entries.length > shown.length
        ? `\n[${entries.length - shown.length} more entries not shown]`
        : '';
    return `${rel}/ (${entries.length} entries)\n${shown.join('\n')}${more}`;
  },
});
