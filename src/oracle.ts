import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Config } from './config.js';
import type { GuideStore } from './guide/store.js';
import type { Logger } from './logger.js';
import { answerQuestion, type AgentPhase, type AgentResult } from './llm/agent.js';
import { findAbbreviations, glossaryNote } from './llm/glossary.js';
import type { LlmClient } from './llm/client.js';
import { Limiter } from './llm/limiter.js';
import { buildSystemPrompt } from './llm/prompts.js';
import { checkTopic, type TopicResult } from './llm/topic.js';
import type { GameRepo } from './repo/sync.js';
import type { RulesStore } from './rules/store.js';
import { codeTools, guideCodeTools, rulesTools, type Tool } from './tools/index.js';
import { topicIndex } from './tools/guide.js';

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
  /** The code guide; needed for LLM_LOOKUP_MODE=guide. */
  guide?: GuideStore;
  llm: LlmClient;
  logger: Logger;
}

export interface AskResult extends AgentResult {
  variant: string;
  commit: string;
  ms: number;
  /** The lookup mode actually used (guide falls back to grep without a guide). */
  lookupMode: 'grep' | 'guide';
}

/** Answers questions about the game: the part of the bot that is independent of Discord. */
export class Oracle {
  private readonly limiter: Limiter;
  private readonly config: Config;
  private readonly repo: GameRepo;
  private readonly rules: RulesStore;
  private readonly guide: GuideStore | undefined;
  private readonly llm: LlmClient;
  private readonly logger: Logger;

  constructor(deps: OracleDeps) {
    this.config = deps.config;
    this.repo = deps.repo;
    this.rules = deps.rules;
    this.guide = deps.guide;
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

  /**
   * Is the last turn about Atlantis? Run before `ask`; a rejected message
   * should not be researched. Never throws (except when aborted): a failed
   * check lets the message through. Not queued behind LLM_MAX_CONCURRENT, so
   * an off-topic message is turned away without waiting for other answers.
   */
  async screen(turns: ChatTurn[], signal?: AbortSignal): Promise<TopicResult> {
    if (!this.config.llm.topicCheck) return { verdict: 'atlantis', allowed: true, ms: 0 };
    const result = await checkTopic({
      llm: this.llm,
      model: this.config.llm.model,
      turns,
      maxTokens: this.config.llm.maxTokens,
      thinking: this.config.llm.thinking,
      signal,
    });
    const log = { question: turns.at(-1)?.content.slice(0, 200), ...result };
    if (result.verdict === 'atlantis') this.logger.debug(log, 'Topic check passed');
    else if (result.verdict === 'other') this.logger.info(log, 'Rejected off-topic message');
    else this.logger.warn(log, 'Topic check inconclusive; answering anyway');
    return result;
  }

  async ask(input: AskInput): Promise<AskResult> {
    const variant = this.resolveVariant(input.variant);
    const commit = this.repo.commit;
    const hasRules = this.rules.get(variant) !== undefined;
    const guide = this.config.llm.lookupMode === 'guide' ? this.guide?.get() : undefined;
    if (this.config.llm.lookupMode === 'guide' && !guide) {
      this.logger.warn('LLM_LOOKUP_MODE=guide but no code guide is loaded; using grep lookup');
    }
    const lookupMode = guide ? 'guide' : 'grep';
    const code = guide ? guideCodeTools : codeTools;
    const tools: Tool[] = hasRules ? [...rulesTools, ...code] : code;
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
          guideTopics: guide ? topicIndex(guide) : undefined,
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
        thinking: this.config.llm.thinking,
        finalMaxTokens: this.config.llm.finalMaxTokens,
        toolOutputBudget: this.config.llm.toolOutputBudget,
        maxIterations: this.config.llm.maxToolIterations,
        messages,
        tools,
        firstTools: rulesTools.map((t) => t.name),
        toolContext: { root: this.repo.dir, variant, rules: this.rules, guide },
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
        lookupMode,
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
    return { ...result, variant, commit, ms, lookupMode };
  }
}
