import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { answerQuestion, type AgentResult } from './llm/agent.js';
import type { LlmClient } from './llm/client.js';
import { Limiter } from './llm/limiter.js';
import { buildSystemPrompt } from './llm/prompts.js';
import type { GameRepo } from './repo/sync.js';
import { defaultTools, type Tool } from './tools/index.js';

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
}

export interface AskResult extends AgentResult {
  variant: string;
  commit: string;
  ms: number;
}

/** Answers questions about the game: the part of the bot that is independent of Discord. */
export class Oracle {
  private readonly limiter: Limiter;

  constructor(
    private readonly config: Config,
    private readonly repo: GameRepo,
    private readonly llm: LlmClient,
    private readonly logger: Logger,
    private readonly tools: Tool[] = defaultTools,
  ) {
    this.limiter = new Limiter(config.llm.maxConcurrent);
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
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          repoUrl: this.config.repo.url,
          commit,
          variant,
          variants: this.repo.variants,
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
        maxIterations: this.config.llm.maxToolIterations,
        messages,
        tools: this.tools,
        toolContext: { root: this.repo.dir },
        signal: input.signal,
        onToolCall: input.onToolCall,
      }),
    );
    const ms = Date.now() - started;

    this.logger.info(
      {
        question: input.turns.at(-1)?.content.slice(0, 200),
        variant,
        iterations: result.iterations,
        hitIterationCap: result.hitIterationCap,
        toolCalls: result.toolCalls.map((c) =>
          `${c.name}${c.ok ? '' : '!'} ${c.args}`.slice(0, 200),
        ),
        usage: result.usage,
        ms,
      },
      'Answered question',
    );
    return { ...result, variant, commit, ms };
  }
}
