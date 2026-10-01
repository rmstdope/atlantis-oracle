import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { runTool, toOpenAITools, type Tool, type ToolContext } from '../tools/index.js';
import { CallMemory, repeatNote } from './callMemory.js';
import type { LlmClient } from './client.js';

export interface ToolCallRecord {
  name: string;
  args: string;
  ok: boolean;
  ms: number;
  /** True when the call repeated an earlier one and got a pointer instead of output. */
  repeat?: boolean;
}

/** One request to the LLM, for diagnosing slow or failing questions. */
export interface LlmCallRecord {
  purpose: 'plan' | 'research' | 'answer' | 'review';
  ms: number;
  promptTokens: number;
  /** Prompt tokens the server reused from its cache; low values on big prompts mean slow calls. */
  cachedTokens: number;
  completionTokens: number;
  /** The reply hit max_tokens and was cut off. */
  truncated?: boolean;
  /** Whether the model was allowed to reason (false when switched off via LLM_THINKING). */
  thinking: boolean;
  /** Tool calls the model asked for in this reply. */
  requestedTools?: number;
  error?: string;
}

/** What the review step did with the draft answer. */
export type ReviewOutcome = 'approved' | 'revised' | 'researched';

export interface AgentResult {
  text: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  hitIterationCap: boolean;
  review?: ReviewOutcome;
  /** True when a failed LLM call during research was recovered by answering early. */
  recovered?: boolean;
  llmCalls: LlmCallRecord[];
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
}

export type AgentPhase = 'planning' | 'researching' | 'reviewing';

export interface AgentOptions {
  llm: LlmClient;
  model: string;
  temperature: number;
  topP?: number;
  /** Output cap per LLM call; stops runaway generations (e.g. looping reasoning). */
  maxTokens?: number;
  /**
   * Reasoning ("thinking") control for servers that support
   * chat_template_kwargs.enable_thinking (vLLM, SGLang, oMLX):
   * on = send nothing (server default), off = no reasoning on any call,
   * final = no reasoning while researching, reasoning for the forced answer
   * and the review, which then use finalMaxTokens.
   */
  thinking?: 'on' | 'off' | 'final';
  /** Output cap for calls that reason in 'final' mode. */
  finalMaxTokens?: number;
  maxIterations: number;
  /** System prompt plus conversation so far, ending with the user's question. */
  messages: ChatCompletionMessageParam[];
  tools: Tool[];
  toolContext: ToolContext;
  /**
   * Names of tools the model must use first (the rules tools). Until one of
   * them has been called, only these are offered.
   */
  firstTools?: string[];
  /** Total characters of tool output per question; protects small context windows. */
  toolOutputBudget?: number;
  /** Ask the model for a research plan before it starts using tools. */
  planStep?: boolean;
  /** Let the model check its draft answer against the research before it is sent. */
  reviewStep?: boolean;
  /** Research rounds allowed when the review asks for more research. */
  reviewResearchIterations?: number;
  signal?: AbortSignal;
  onToolCall?: (name: string, args: string) => void;
  onPhase?: (phase: AgentPhase) => void;
}

/** Thrown when a question fails; carries what was done before the failure. */
export class AgentError extends Error {
  constructor(
    cause: unknown,
    readonly partial: Pick<AgentResult, 'toolCalls' | 'llmCalls' | 'usage' | 'iterations'>,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AgentError';
  }
}

export const FALLBACK_ANSWER =
  "Sorry, I couldn't come up with an answer this time. Try rephrasing the question.";

const RULES_FIRST_PROMPT =
  'Before answering, look the question up in the game rules with the rules tools. ' +
  'If the rules do not settle it, you can research the code afterwards.';

/** When this many research rounds remain, tool results remind the model to conclude. */
const BUDGET_WARNING_ROUNDS = 4;

const NO_TOOLS_PROMPT =
  'Tools are no longer available. Write your final answer to the player now, as text, ' +
  'using what you have already found.';

const TRUNCATED_PROMPT =
  'Your last reply was cut off because it was too long. Answer now, concisely, from what you have found.';

/** Tool outputs are cut to this length when recovering from a failed call. */
const RECOVERY_TOOL_CHARS = 1500;

const FORCE_ANSWER_PROMPT =
  'You have used all available research steps. Answer the question now using only what you have ' +
  'found so far, and say clearly what remains uncertain.';

export const PLAN_PROMPT =
  'Before using any tools, write a short research plan as a few bullet points: which facts you ' +
  'need to answer the question completely, and where you expect to find each one (a rules ' +
  'section, a compendium entry, or the code). Do not answer the question yet.';

const START_RESEARCH_PROMPT = 'Now carry out the plan with the tools, then answer the question.';

export const REVIEW_PROMPT = `Review your draft answer above before it is sent to the player. Check that:
1. Every number, name and rule in it is supported by a tool result in this conversation, not by memory.
2. It answers every part of the question. If the question asks how much, how many or what level, the answer gives a concrete figure or a worked calculation with its assumptions stated.
3. It does not explain how to exploit flaws in the game code.
4. It follows the answer style from the system prompt.
Reply with exactly one of:
- APPROVED, if the draft needs no changes.
- RESEARCH: <what is missing>, if essential facts are missing and can be looked up with the tools.
- REVISED: followed by the complete corrected answer, otherwise. Everything after REVISED: is sent to the player as it is, so write only the answer there and do not mention the draft or this review.`;

/** Paragraphs about the review itself ("The draft's estimate is too vague..."). */
const REVIEW_TALK = /\b(the|my|your) draft\b|\breview\b/i;

/**
 * Extracts the corrected answer from a review reply. Models often write their
 * critique first; only the text after REVISED: (or, without the marker, after
 * any leading paragraphs about the draft) is an answer for the player.
 */
export function revisedAnswer(verdict: string): string {
  const marker = /(^|\n)\s*\**REVISED:?\**:?\s*/i.exec(verdict);
  if (marker) return verdict.slice(marker.index + marker[0].length).trim();
  const paragraphs = verdict.split(/\n\s*\n/);
  while (paragraphs.length > 0 && REVIEW_TALK.test(paragraphs[0]!)) paragraphs.shift();
  return paragraphs.join('\n\n').trim();
}

/** Removes reasoning blocks some local models put in their content. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]*?<\/think>/, '') // opening tag supplied by the chat template
    .replace(/<think>[\s\S]*$/, '') // reasoning cut off before its closing tag
    .trim();
}

export async function answerQuestion(opts: AgentOptions): Promise<AgentResult> {
  const first = new Set(opts.firstTools?.filter((n) => opts.tools.some((t) => t.name === n)));
  // Gate only when the first tools are actually available.
  let unlocked = first.size === 0;
  let nudged = false;
  const allTools = toOpenAITools(opts.tools);
  const firstOnly = toOpenAITools(opts.tools.filter((t) => first.has(t.name)));
  const messages = [...opts.messages];
  const toolCalls: ToolCallRecord[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  let budget = opts.toolOutputBudget ?? 60_000;
  const memory = new CallMemory();
  let iterations = 0;
  let hitIterationCap = false;
  let recovered = false;
  const llmCalls: LlmCallRecord[] = [];

  const complete = async (withTools: boolean, purpose: LlmCallRecord['purpose']) => {
    const started = Date.now();
    const mode = opts.thinking ?? 'on';
    const thinking =
      mode === 'on' || (mode === 'final' && (purpose === 'answer' || purpose === 'review'));
    const maxTokens =
      mode === 'final' && thinking ? (opts.finalMaxTokens ?? opts.maxTokens) : opts.maxTokens;
    const params = {
      model: opts.model,
      messages,
      temperature: opts.temperature,
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(withTools
        ? { tools: unlocked ? allTools : firstOnly, tool_choice: 'auto' as const }
        : {}),
      // Not part of the OpenAI API; sent only when LLM_THINKING asks for it.
      ...(mode !== 'on' ? { chat_template_kwargs: { enable_thinking: thinking } } : {}),
    } as ChatCompletionCreateParamsNonStreaming;
    let res;
    try {
      res = await opts.llm.complete(params, opts.signal);
    } catch (err) {
      llmCalls.push({
        purpose,
        thinking,
        ms: Date.now() - started,
        promptTokens: 0,
        cachedTokens: 0,
        completionTokens: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    llmCalls.push({
      purpose,
      thinking,
      ms: Date.now() - started,
      promptTokens: res.usage?.prompt_tokens ?? 0,
      cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      ...(res.choices?.[0]?.finish_reason === 'length' ? { truncated: true } : {}),
      ...(res.choices?.[0]?.message?.tool_calls?.length
        ? { requestedTools: res.choices[0].message.tool_calls.length }
        : {}),
    });
    usage.promptTokens += res.usage?.prompt_tokens ?? 0;
    usage.completionTokens += res.usage?.completion_tokens ?? 0;
    usage.cachedTokens += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    // Some servers answer overload or model errors with HTTP 200 and no choices.
    const message = res.choices?.[0]?.message;
    if (!message) {
      const detail = (res as { error?: { message?: string } }).error?.message;
      throw new Error(`LLM response contained no message${detail ? `: ${detail}` : ''}`);
    }
    return message;
  };

  const runCall = async (call: ChatCompletionMessageFunctionToolCall) => {
    opts.onToolCall?.(call.function.name, call.function.arguments);
    const started = Date.now();
    const earlier = memory.earlier(call.function.name, call.function.arguments);
    if (earlier !== undefined) {
      toolCalls.push({
        name: call.function.name,
        args: call.function.arguments,
        ok: true,
        ms: 0,
        repeat: true,
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: repeatNote(call.function.name, earlier),
      });
      return;
    }
    let output: string;
    let ok: boolean;
    if (budget <= 0) {
      output = 'Error: research budget exhausted. Answer with what you have.';
      ok = false;
    } else if (!unlocked && !first.has(call.function.name)) {
      output = `Error: check the game rules first (${[...first].join(', ')}); the code tools become available afterwards.`;
      ok = false;
    } else {
      ({ output, ok } = await runTool(
        opts.tools,
        call.function.name,
        call.function.arguments,
        opts.toolContext,
      ));
      budget -= output.length;
    }
    if (ok && first.has(call.function.name)) unlocked = true;
    if (ok) memory.remember(call.function.name, call.function.arguments, toolCalls.length + 1);
    toolCalls.push({
      name: call.function.name,
      args: call.function.arguments,
      ok,
      ms: Date.now() - started,
    });
    messages.push({ role: 'tool', tool_call_id: call.id, content: output });
  };

  /** Asks for an answer from what has been found, without tools. */
  const forceAnswer = async (shorten: boolean): Promise<string> => {
    if (shorten) {
      // A failed call usually means the context got too large for the server.
      for (const m of messages) {
        if (
          m.role === 'tool' &&
          typeof m.content === 'string' &&
          m.content.length > RECOVERY_TOOL_CHARS
        ) {
          m.content = `${m.content.slice(0, RECOVERY_TOOL_CHARS)}\n[shortened]`;
        }
      }
    }
    iterations++;
    messages.push({ role: 'user', content: FORCE_ANSWER_PROMPT });
    let reply = await complete(false, 'answer');
    if (!stripThinking(reply.content ?? '') && reply.tool_calls?.length) {
      // Some models keep calling tools even when none are offered; say so once.
      iterations++;
      messages.push({ role: 'user', content: NO_TOOLS_PROMPT });
      reply = await complete(false, 'answer');
    }
    // Servers return unfinished reasoning as plain content when max_tokens cuts
    // it off, so a cut-off reply is never an answer the player should see.
    return llmCalls.at(-1)?.truncated ? '' : stripThinking(reply.content ?? '');
  };

  /** The tool loop: returns the model's answer once it stops calling tools. */
  const research = async (maxRounds: number): Promise<string> => {
    let cutOff = false;
    for (let round = 1; round <= maxRounds; round++) {
      iterations++;
      let message;
      try {
        message = await complete(true, 'research');
      } catch (err) {
        // Keep the research done so far instead of failing the whole question.
        if (opts.signal?.aborted || toolCalls.length === 0) throw err;
        recovered = true;
        try {
          return await forceAnswer(true);
        } catch {
          throw err;
        }
      }
      const calls = (message.tool_calls ?? [])
        .filter((c): c is ChatCompletionMessageFunctionToolCall => c.type === 'function')
        .map((c) => ({ ...c, id: c.id || `call_${randomUUID()}` }));

      if (calls.length === 0) {
        const content = stripThinking(message.content ?? '');
        if (llmCalls.at(-1)?.truncated && !cutOff) {
          // The reply ran out of tokens (e.g. endless reasoning or a half-finished
          // calculation); a cut-off answer must not reach the player, so ask once more.
          cutOff = true;
          messages.push({ role: 'user', content: TRUNCATED_PROMPT });
          continue;
        }
        if (llmCalls.at(-1)?.truncated) return ''; // cut off again: no usable answer
        if (!unlocked && !nudged) {
          // The model tried to answer from memory; ask it once to check the rules.
          nudged = true;
          if (message.content) messages.push({ role: 'assistant', content: message.content });
          messages.push({ role: 'user', content: RULES_FIRST_PROMPT });
          continue;
        }
        return content;
      }

      messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
      for (const call of calls) await runCall(call);

      const remaining = maxRounds - round;
      const last = messages.at(-1);
      if (remaining > 0 && remaining <= BUDGET_WARNING_ROUNDS && last?.role === 'tool') {
        last.content += `\n\n[Research round ${round} of ${maxRounds}: ${remaining} left. Start concluding and answer soon.]`;
      }
    }

    hitIterationCap = true;
    return forceAnswer(false);
  };

  const run = async (): Promise<AgentResult> => {
    if (opts.planStep) {
      opts.onPhase?.('planning');
      messages.push({ role: 'user', content: PLAN_PROMPT });
      // The plan is an aid; a failed call just means researching without one.
      const plan = await complete(false, 'plan')
        .then((m) => stripThinking(m.content ?? ''))
        .catch(() => '');
      if (plan) {
        messages.push({ role: 'assistant', content: plan });
        messages.push({ role: 'user', content: START_RESEARCH_PROMPT });
      } else {
        messages.pop(); // No usable plan; research without one.
      }
    }

    opts.onPhase?.('researching');
    let text = await research(opts.maxIterations);
    let review: ReviewOutcome | undefined;

    if (opts.reviewStep && text) {
      opts.onPhase?.('reviewing');
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: REVIEW_PROMPT });
      // A failed review keeps the draft rather than losing the answer.
      // A cut-off review is half-finished reasoning, not an answer: keep the draft.
      const verdict = await complete(false, 'review')
        .then((m) => (llmCalls.at(-1)?.truncated ? '' : stripThinking(m.content ?? '')))
        .catch(() => '');
      const missing = /^RESEARCH:\s*([\s\S]*)$/i.exec(verdict);
      if (missing) {
        review = 'researched';
        messages.push({ role: 'assistant', content: verdict });
        messages.push({
          role: 'user',
          content: `Research what is missing: ${missing[1]!.trim()}\nThen write the complete final answer for the player.`,
        });
        opts.onPhase?.('researching');
        // The draft is complete; if the extra research fails, keep it.
        text = (await research(opts.reviewResearchIterations ?? 6).catch(() => '')) || text;
      } else if (/^APPROVED\b/i.test(verdict) || !verdict) {
        review = 'approved';
      } else {
        const revised = revisedAnswer(verdict);
        // Nothing left after dropping review talk: keep the draft.
        review = revised ? 'revised' : 'approved';
        if (revised) text = revised;
      }
    }

    return {
      text: text || FALLBACK_ANSWER,
      toolCalls,
      iterations,
      hitIterationCap,
      review,
      recovered,
      llmCalls,
      usage,
    };
  };

  try {
    return await run();
  } catch (err) {
    throw new AgentError(err, { toolCalls, llmCalls, usage, iterations });
  }
}
