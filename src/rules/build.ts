import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface BuildRequest {
  repoDir: string;
  variants: string[];
  /** Scratch directory owned by the builder; wiped for each build. */
  workDir: string;
  logger: Logger;
}

export interface BuiltRules {
  /** Rules HTML from `<variant> genrules`. */
  html: string;
  /** Output of native/compendium.cpp; absent when it could not be built for this engine. */
  compendium?: string;
}

/** Builds rules for the requested variants; returns results for the variants that succeeded. */
export type RulesBuilder = (req: BuildRequest) => Promise<Map<string, BuiltRules>>;

/** native/compendium.cpp, relative to this module in both src/ and dist/. */
export const COMPENDIUM_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../native/compendium.cpp',
);

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${cmd} ${args.join(' ')} failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Compiles native/compendium.cpp against the variant's engine objects (the
 * Makefile's layout: obj/*.o and <variant>/obj/*.o) and returns its output.
 */
async function buildCompendium(src: string, variant: string, out: string): Promise<string> {
  const engine = (await readdir(path.join(src, 'obj')))
    .filter((f) => f.endsWith('.o') && f !== 'main.o')
    .map((f) => path.join('obj', f));
  const ruleset = (await readdir(path.join(src, variant, 'obj')))
    .filter((f) => f.endsWith('.o'))
    .map((f) => path.join(variant, 'obj', f));
  const binary = path.join(out, `compendium-${variant}`);
  await run(
    'g++',
    ['-g', '-I.', '-I..', '-std=c++20', '-o', binary, COMPENDIUM_SOURCE, ...engine, ...ruleset],
    src,
    5 * 60_000,
  );
  const { stdout } = await execFileAsync(binary, [], {
    cwd: src,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds each variant with the game's own Makefile and flags, then runs
 * `<variant> genrules`. Works on a `git archive` export so build artifacts
 * never land in the clone the tools search.
 */
export const makeRulesBuilder: RulesBuilder = async ({ repoDir, variants, workDir, logger }) => {
  const src = path.join(workDir, 'src');
  const out = path.join(workDir, 'out');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(src, { recursive: true });
  await mkdir(out, { recursive: true });

  const { stdout: archive } = await execFileAsync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: repoDir,
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-x', '-C', src], { stdio: ['pipe', 'ignore', 'pipe'] });
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    tar.stdin.end(archive);
  });

  if (!(await exists(path.join(src, 'Makefile')))) {
    throw new Error('The game repository has no Makefile');
  }

  const built = new Map<string, BuiltRules>();
  const jobs = String(Math.max(1, availableParallelism()));
  for (const variant of variants) {
    const started = Date.now();
    try {
      const intro = path.join(variant, `${variant}_intro.html`);
      if (!(await exists(path.join(src, intro)))) throw new Error(`missing ${intro}`);
      await run('make', ['-j', jobs, `GAME=${variant}`], src, 15 * 60_000);
      const html = path.join(out, `${variant}.html`);
      await run(
        path.join(src, variant, variant),
        ['genrules', intro, `${variant}.css`, html],
        src,
        60_000,
      );
      let compendium: string | undefined;
      try {
        compendium = await buildCompendium(src, variant, out);
        await writeFile(path.join(out, `${variant}.compendium.txt`), compendium);
      } catch (err) {
        // Forks or older engines may lack the report functions; rules still work without it.
        logger.warn(
          { variant, err: err instanceof Error ? err.message.slice(0, 500) : err },
          'Compendium build failed; using the rules without it',
        );
      }
      built.set(variant, { html, compendium });
      logger.info(
        { variant, compendium: compendium !== undefined, ms: Date.now() - started },
        'Built rules',
      );
    } catch (err) {
      logger.warn({ variant, err: err instanceof Error ? err.message : err }, 'Rules build failed');
    }
  }
  return built;
};
