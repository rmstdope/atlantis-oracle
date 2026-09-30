import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import { resolveInRepo, toRepoRelative } from '../repo/paths.js';
import { defineTool, ToolError, truncate } from './types.js';

const OUTPUT_BUDGET = 6000;

// Vendored libraries and turn snapshots are noise for rules questions.
const EXCLUDES = ['!external/**', '!snapshot-tests/turns/**', '!snapshot-tests/*_turns/**'];

function runRg(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      rgPath,
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') return reject(err);
        resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
      },
    );
  });
}

export const searchCode = defineTool({
  name: 'search_code',
  description:
    'Search the game repository with ripgrep. Returns matching lines as `path:line:text` ' +
    '(context lines use `path-line-text`). Use it to locate items, skills, orders, constants and ' +
    'rules text. Case-insensitive unless the pattern contains uppercase letters.',
  schema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe('Regular expression (Rust regex syntax), or literal text if fixed_strings is true'),
    path: z
      .string()
      .optional()
      .describe('Directory or file to search in, relative to the repo root. Default: whole repo'),
    glob: z
      .string()
      .optional()
      .describe('Only search files matching this glob, e.g. "*.cpp" or "standard/*"'),
    fixed_strings: z.boolean().optional().describe('Treat pattern as literal text'),
    context: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Context lines around each match (default 1)'),
  }),
  async handler(args, ctx) {
    const rootReal = await realpath(ctx.root);
    const target = toRepoRelative(rootReal, await resolveInRepo(rootReal, args.path ?? '.'));
    const rgArgs = [
      '--line-number',
      '--no-heading',
      '--color=never',
      '--smart-case',
      '--max-count=30',
      '--max-columns=300',
      '--max-columns-preview',
      `--context=${args.context ?? 1}`,
      ...EXCLUDES.flatMap((g) => ['--glob', g]),
      ...(args.glob ? ['--glob', args.glob] : []),
      ...(args.fixed_strings ? ['--fixed-strings'] : []),
      '--regexp',
      args.pattern,
      '--',
      target,
    ];
    const { code, stdout, stderr } = await runRg(rgArgs, rootReal);
    if (code === 1) return `No matches for ${JSON.stringify(args.pattern)} in ${target}.`;
    if (code !== 0)
      throw new ToolError(`search failed: ${stderr.trim().split('\n').slice(0, 5).join(' ')}`);
    const out = stdout.replace(/^\.\//gm, '');
    return truncate(out.trimEnd(), OUTPUT_BUDGET, 'use a more specific pattern, path or glob');
  },
});
