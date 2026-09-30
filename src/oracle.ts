import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { answerQuestion, type AgentPhase, type AgentResult } from './llm/agent.js';
import { findAbbreviations, glossaryNote } from './llm/glossary.js';
import type { LlmClient } from './llm/client.js';
import { Limiter } from './llm/limiter.js';
import { buildSystemPrompt } from './llm/prompts.js';
import type { GameRepo } from './repo/sync.js';
import type { RulesStore } from './rules/store.js';
import { codeTools, rulesTools, type Tool } from './tools/index.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskInput {
  /** Earlier turns plus the new question as the last user turn. */
  turns: ChatTurn[];
  variant?: string;
  signal?: AbortSignal;
  onToolCall?: (name: string, args: string) => void;
  onPhase?: (phase: AgentPhase) => void;
}

export interface OracleDeps {
  config: Config;
  repo: GameRepo;
  rules: RulesStore;
  llm: LlmClient;
  logger: Logger;
}

export interface AskResult extends AgentResult {
  variant: string;
  commit: string;
  ms: number;
}

/** Answers questions about the game: the part of the bot that is independent of Discord. */
export class Oracle {
  private readonly limiter: Limiter;
  private readonly config: Config;
  private readonly repo: GameRepo;
  private readonly rules: RulesStore;
  private readonly llm: LlmClient;
  private readonly logger: Logger;

  constructor(deps: OracleDeps) {
    this.config = deps.config;
    this.repo = deps.repo;
    this.rules = deps.rules;
    this.llm = deps.llm;
    this.logger = deps.logger;
    this.limiter = new Limiter(this.config.llm.maxConcurrent);
  }

  /** Questions waiting for an LLM slot. */
  get queueLength(): number {
    return this.limiter.waiting;
  }

  /** Maps a requested variant to a known one (case-insensitive), falling back to the default. */
  resolveVariant(requested?: string): string {
    const wanted = requested?.trim().toLowerCase();
    return this.repo.variants.find((v) => v.toLowerCase() === wanted) ?? this.config.defaultVariant;
  }

  async ask(input: AskInput): Promise<AskResult> {
    const variant = this.resolveVariant(input.variant);
    const commit = this.repo.commit;
    const hasRules = this.rules.get(variant) !== undefined;
    const tools: Tool[] = hasRules ? [...rulesTools, ...codeTools] : codeTools;
    const question = input.turns.at(-1)?.content ?? '';
    const glossary = glossaryNote(await findAbbreviations(this.repo.dir, question));
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          repoUrl: this.config.repo.url,
          commit,
          variant,
          variants: this.repo.variants,
          hasRules,
          glossary,
        }),
      },
      ...input.turns,
    ];

    const started = Date.now();
    const result = await this.limiter.run(() =>
      answerQuestion({
        llm: this.llm,
        model: this.config.llm.model,
        temperature: this.config.llm.temperature,
        topP: this.config.llm.topP,
        maxTokens: this.config.llm.maxTokens,
        toolOutputBudget: this.config.llm.toolOutputBudget,
        maxIterations: this.config.llm.maxToolIterations,
        messages,
        tools,
        firstTools: rulesTools.map((t) => t.name),
        toolContext: { root: this.repo.dir, variant, rules: this.rules },
        planStep: this.config.llm.planStep,
        reviewStep: this.config.llm.reviewStep,
        signal: input.signal,
        onToolCall: input.onToolCall,
        onPhase: input.onPhase,
      }),
    );
    const ms = Date.now() - started;

    this.logger.info(
      {
        question: input.turns.at(-1)?.content.slice(0, 200),
        variant,
        iterations: result.iterations,
        hitIterationCap: result.hitIterationCap,
        review: result.review,
        recovered: result.recovered,
        toolCalls: result.toolCalls.map((c) =>
          `${c.name}${c.ok ? '' : '!'} ${c.args}`.slice(0, 200),
        ),
        usage: result.usage,
        llmCalls: result.llmCalls.length,
        slowestLlmCallMs: Math.max(0, ...result.llmCalls.map((c) => c.ms)),
        ms,
      },
      'Answered question',
    );
    return { ...result, variant, commit, ms };
  }
}
