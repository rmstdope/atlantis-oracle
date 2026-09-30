import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createLlmClient } from './llm/client.js';
import { createLogger } from './logger.js';
import { Oracle } from './oracle.js';
import { GameRepo } from './repo/sync.js';
import { RulesStore } from './rules/store.js';

const USAGE = 'Usage: npm run ask -- [--variant <name>] [--no-sync] "<question>"';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      variant: { type: 'string', short: 'v' },
      'no-sync': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const question = positionals.join(' ').trim();
  if (values.help || !question) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel, 2);
  const repo = new GameRepo(config.repo, logger);
  if (values['no-sync']) {
    await repo.loadExisting();
  } else {
    await repo.sync();
  }

  const rules = new RulesStore(config.rules, logger);
  await rules.prepare(repo);

  const oracle = new Oracle({ config, repo, rules, llm: createLlmClient(config.llm), logger });
  const result = await oracle.ask({
    turns: [{ role: 'user', content: question }],
    variant: values.variant,
    onToolCall: (name, args) => console.error(`  → ${name} ${args}`),
    onPhase: (phase) => console.error(`[${phase}]`),
  });

  console.log(result.text);
  console.error(
    `\n[${result.variant} @ ${result.commit.slice(0, 10)} · ${result.iterations} rounds · ` +
      `${result.toolCalls.length} tool calls · ${result.usage.promptTokens}+${result.usage.completionTokens} tokens ` +
      `(${result.usage.cachedTokens} cached) · ` +
      `${(result.ms / 1000).toFixed(1)}s${result.hitIterationCap ? ' · hit iteration cap' : ''}` +
      `${result.review ? ` · review: ${result.review}` : ''}]`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
