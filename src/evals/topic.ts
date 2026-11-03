import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createLlmClient } from '../llm/client.js';
import { checkTopic } from '../llm/topic.js';
import { evalQuestionSchema } from './score.js';

/**
 * `npm run eval:topic`: runs only the topic check (no research) over every
 * answer eval question, which must all pass, and over the labelled messages
 * in evals/topic.json. Reports false rejections first: they cost real players.
 */
const turnSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
const caseSchema = z.object({
  id: z.string().min(1),
  message: z.string().min(1),
  /** Earlier turns, for follow-ups. */
  context: z.array(turnSchema).default([]),
  /** `either`: shown, not scored (e.g. an injection riding on a real question). */
  expect: z.enum(['atlantis', 'other', 'either']),
});
type Case = z.infer<typeof caseSchema>;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cases: { type: 'string', default: 'evals/topic.json' },
      questions: { type: 'string', default: 'evals/questions.json' },
    },
  });
  const config = loadConfig();
  const llm = createLlmClient(config.llm);
  const questions = z
    .array(evalQuestionSchema)
    .parse(JSON.parse(await readFile(values.questions!, 'utf8')));
  const cases: Case[] = [
    ...questions.map((q) => ({
      id: `question:${q.id}`,
      message: q.question,
      context: [],
      expect: 'atlantis' as const,
    })),
    ...z.array(caseSchema).parse(JSON.parse(await readFile(values.cases!, 'utf8'))),
  ];

  let wrong = 0;
  let falseRejections = 0;
  let ms = 0;
  for (const c of cases) {
    const r = await checkTopic({
      llm,
      model: config.llm.model,
      turns: [...c.context, { role: 'user', content: c.message }],
      maxTokens: config.llm.maxTokens,
      thinking: config.llm.thinking,
    });
    ms += r.ms;
    const got = r.allowed ? 'atlantis' : 'other';
    const ok = c.expect === 'either' || got === c.expect;
    if (!ok) wrong++;
    if (!ok && c.expect === 'atlantis') falseRejections++;
    const mark = c.expect === 'either' ? '·' : ok ? '✅' : '❌';
    console.log(
      `${mark} ${c.id.padEnd(32)} expected ${c.expect.padEnd(8)} got ${r.verdict}` +
        ` (${r.ms} ms)${r.call?.truncated ? ' TRUNCATED' : ''}${r.call?.error ? ` ERROR ${r.call.error}` : ''}`,
    );
  }
  const scored = cases.filter((c) => c.expect !== 'either').length;
  console.log(
    `\nModel ${config.llm.model} · ${scored - wrong}/${scored} correct · ` +
      `${falseRejections} false rejection(s) · mean ${Math.round(ms / cases.length)} ms`,
  );
  if (wrong > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
