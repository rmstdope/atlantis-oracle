import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { AgentError, type LlmCallRecord } from '../llm/agent.js';
import { createLlmClient } from '../llm/client.js';
import { createLogger } from '../logger.js';
import { Oracle } from '../oracle.js';
import { GameRepo } from '../repo/sync.js';
import { RulesStore } from '../rules/store.js';
import { evalQuestionSchema, scoreAnswer, type Score } from './score.js';

const REPORT_DIR = path.resolve('data/evals');

interface EvalResult extends Score {
  id: string;
  tier: string;
  answer: string;
  ms: number;
  iterations: number;
  toolCalls: number;
  hitIterationCap: boolean;
  review?: string;
  /** Every tool call in order, e.g. "read_rules {\"section\":\"balrog\"}"; repeats marked. */
  trace: string[];
  /** Every LLM request, e.g. "research 48s 31204+180 tokens". */
  llmCalls: string[];
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

interface Report {
  startedAt: string;
  botCommit: string;
  model: string;
  settings: Record<string, unknown>;
  gameCommit: string;
  results: EvalResult[];
}

async function previousReport(): Promise<Report | undefined> {
  try {
    const files = (await readdir(REPORT_DIR)).filter((f) => f.endsWith('.json')).sort();
    const last = files.at(-1);
    return last
      ? (JSON.parse(await readFile(path.join(REPORT_DIR, last), 'utf8')) as Report)
      : undefined;
  } catch {
    return undefined;
  }
}

const describeLlmCall = (c: LlmCallRecord) =>
  `${c.purpose}${c.thinking ? '' : ' (no thinking)'} ${Math.round(c.ms / 1000)}s ${c.promptTokens}+${c.completionTokens} tokens` +
  ` (${c.cachedTokens} cached)` +
  (c.truncated ? ' TRUNCATED' : '') +
  (c.error ? ` ERROR ${c.error}` : '');

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(0)}s`;
const delta = (now: number, before: number | undefined, fmt: (x: number) => string) =>
  before === undefined ? '' : ` (${now - before >= 0 ? '+' : ''}${fmt(now - before)})`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string', multiple: true },
      tier: { type: 'string' },
      sync: { type: 'boolean' },
      questions: { type: 'string', default: 'evals/questions.json' },
    },
  });

  const all = z
    .array(evalQuestionSchema)
    .parse(JSON.parse(await readFile(values.questions!, 'utf8')));
  const questions = all.filter(
    (q) => (!values.only || values.only.includes(q.id)) && (!values.tier || q.tier === values.tier),
  );
  if (questions.length === 0) throw new Error('No questions selected');

  const config = loadConfig();
  const logger = createLogger(config.logLevel === 'debug' ? 'debug' : 'warn', 2);
  const repo = new GameRepo(config.repo, logger);
  if (values.sync) await repo.sync();
  else await repo.loadExisting();
  const rules = new RulesStore(config.rules, logger);
  await rules.prepare(repo);
  const oracle = new Oracle({ config, repo, rules, llm: createLlmClient(config.llm), logger });

  const before = await previousReport();
  const report: Report = {
    startedAt: new Date().toISOString(),
    botCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    model: config.llm.model,
    settings: { ...config.llm, apiKey: undefined, baseURL: new URL(config.llm.baseURL).host },
    gameCommit: repo.commit,
    results: [],
  };

  for (const q of questions) {
    process.stderr.write(`▶ ${q.id} … `);
    const started = Date.now();
    let result: EvalResult;
    try {
      const r = await oracle.ask({
        turns: [{ role: 'user', content: q.question }],
        variant: q.variant,
      });
      result = {
        id: q.id,
        tier: q.tier,
        answer: r.text,
        ms: r.ms,
        iterations: r.iterations,
        toolCalls: r.toolCalls.length,
        hitIterationCap: r.hitIterationCap,
        review: r.review,
        trace: r.toolCalls.map(
          (c) => `${c.repeat ? '(repeat) ' : c.ok ? '' : '(failed) '}${c.name} ${c.args}`,
        ),
        llmCalls: r.llmCalls.map(describeLlmCall),
        promptTokens: r.usage.promptTokens,
        completionTokens: r.usage.completionTokens,
        ...scoreAnswer(q, r.text),
      };
    } catch (err) {
      // Keep what the agent did before failing; that is what explains the failure.
      const partial = err instanceof AgentError ? err.partial : undefined;
      result = {
        id: q.id,
        tier: q.tier,
        answer: '',
        ms: Date.now() - started,
        iterations: partial?.iterations ?? 0,
        toolCalls: partial?.toolCalls.length ?? 0,
        hitIterationCap: false,
        trace: partial?.toolCalls.map((c) => `${c.name} ${c.args}`) ?? [],
        llmCalls: partial?.llmCalls.map(describeLlmCall) ?? [],
        promptTokens: partial?.usage.promptTokens ?? 0,
        completionTokens: partial?.usage.completionTokens ?? 0,
        recall: 0,
        missing: q.mustMention,
        forbidden: [],
        pass: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    report.results.push(result);
    process.stderr.write(
      `${pct(result.recall)} in ${secs(result.ms)}${result.error ? ` ERROR ${result.error}` : ''}\n`,
    );
    // Save after every question so a long run can be inspected or interrupted.
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(
      path.join(REPORT_DIR, `${report.startedAt.replace(/[:.]/g, '-')}.json`),
      JSON.stringify(report, null, 2),
    );
  }

  console.log(
    `\nModel ${report.model} · bot ${report.botCommit} · game ${report.gameCommit.slice(0, 10)}`,
  );
  if (before)
    console.log(`Compared with ${before.startedAt} (bot ${before.botCommit}, ${before.model})`);
  for (const r of report.results) {
    const prev = before?.results.find((p) => p.id === r.id);
    console.log(
      `${r.pass ? '✅' : '❌'} ${r.id.padEnd(24)} recall ${pct(r.recall)}${delta(r.recall, prev?.recall, pct)}` +
        ` · ${secs(r.ms)}${delta(r.ms, prev?.ms, secs)} · ${r.toolCalls} calls` +
        `${r.hitIterationCap ? ' · CAP' : ''}${r.review ? ` · ${r.review}` : ''}${r.forbidden.length ? ` · FORBIDDEN ${r.forbidden.join(', ')}` : ''}` +
        `${r.missing.length ? `\n     missing: ${r.missing.join(' | ')}` : ''}`,
    );
  }
  const avg = report.results.reduce((s, r) => s + r.recall, 0) / report.results.length;
  const passed = report.results.filter((r) => r.pass).length;
  console.log(`\nMean recall ${pct(avg)} · ${passed}/${report.results.length} passed`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
