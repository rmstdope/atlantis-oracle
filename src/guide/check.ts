import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { GameRepo } from '../repo/sync.js';
import { parseGuide, resolveGuide } from './store.js';

/** `npm run guide:check`: reports guide entries that no longer resolve in the checked-out repo. */
async function main(): Promise<void> {
  const config = loadConfig();
  const repo = new GameRepo(config.repo, createLogger('warn', 2));
  await repo.loadExisting();
  const { topics, warnings } = parseGuide(await readFile(config.guide.path, 'utf8'));
  const guide = await resolveGuide(topics, repo.dir, repo.commit);
  const entries = topics.reduce((n, t) => n + t.entries.length, 0);
  console.log(
    `${config.guide.path}: ${topics.length} topics, ${entries} entries, game ${repo.commit.slice(0, 10)}`,
  );
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const u of guide.unresolved) console.log(`✗ ${u}`);
  if (warnings.length === 0 && guide.unresolved.length === 0) console.log('✓ all entries resolve');
  process.exitCode = guide.unresolved.length > 0 || warnings.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
