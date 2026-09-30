import { randomUUID } from 'node:crypto';
import type {
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

/** What the review step did with the draft answer. */
export type ReviewOutcome = 'approved' | 'revised' | 'researched';

export interface AgentResult {
  text: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  hitIterationCap: boolean;
  review?: ReviewOutcome;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
}

export type AgentPhase = 'planning' | 'researching' | 'reviewing';

export interface AgentOptions {
  llm: LlmClient;
  model: string;
  temperature: number;
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

export const FALLBACK_ANSWER =
  "Sorry, I couldn't come up with an answer this time. Try rephrasing the question.";

const RULES_FIRST_PROMPT =
  'Before answering, look the question up in the game rules with the rules tools. ' +
  'If the rules do not settle it, you can research the code afterwards.';

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
- The complete corrected answer, otherwise. Write it for the player and do not mention this review.`;

/** Removes reasoning blocks some local models put in their content. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]*?<\/think>/, '') // opening tag supplied by the chat template
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

  const complete = async (withTools: boolean) => {
    const res = await opts.llm.complete(
      {
        model: opts.model,
        messages,
        temperature: opts.temperature,
        ...(withTools
          ? { tools: unlocked ? allTools : firstOnly, tool_choice: 'auto' as const }
          : {}),
      },
      opts.signal,
    );
    usage.promptTokens += res.usage?.prompt_tokens ?? 0;
    usage.completionTokens += res.usage?.completion_tokens ?? 0;
    usage.cachedTokens += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const message = res.choices[0]?.message;
    if (!message) throw new Error('LLM response contained no message');
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

  /** The tool loop: returns the model's answer once it stops calling tools. */
  const research = async (maxRounds: number): Promise<string> => {
    for (let round = 1; round <= maxRounds; round++) {
      iterations++;
      const message = await complete(true);
      const calls = (message.tool_calls ?? [])
        .filter((c): c is ChatCompletionMessageFunctionToolCall => c.type === 'function')
        .map((c) => ({ ...c, id: c.id || `call_${randomUUID()}` }));

      if (calls.length === 0) {
        if (!unlocked && !nudged) {
          // The model tried to answer from memory; ask it once to check the rules.
          nudged = true;
          if (message.content) messages.push({ role: 'assistant', content: message.content });
          messages.push({ role: 'user', content: RULES_FIRST_PROMPT });
          continue;
        }
        return stripThinking(message.content ?? '');
      }

      messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
      for (const call of calls) await runCall(call);
    }

    hitIterationCap = true;
    iterations++;
    messages.push({ role: 'user', content: FORCE_ANSWER_PROMPT });
    return stripThinking((await complete(false)).content ?? '');
  };

  if (opts.planStep) {
    opts.onPhase?.('planning');
    messages.push({ role: 'user', content: PLAN_PROMPT });
    const plan = stripThinking((await complete(false)).content ?? '');
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
    const verdict = stripThinking((await complete(false)).content ?? '');
    const missing = /^RESEARCH:\s*([\s\S]*)$/i.exec(verdict);
    if (missing) {
      review = 'researched';
      messages.push({ role: 'assistant', content: verdict });
      messages.push({
        role: 'user',
        content: `Research what is missing: ${missing[1]!.trim()}\nThen write the complete final answer for the player.`,
      });
      opts.onPhase?.('researching');
      text = (await research(opts.reviewResearchIterations ?? 6)) || text;
    } else if (/^APPROVED\b/i.test(verdict) || !verdict) {
      review = 'approved';
    } else {
      review = 'revised';
      text = verdict;
    }
  }

  return {
    text: text || FALLBACK_ANSWER,
    toolCalls,
    iterations,
    hitIterationCap,
    review,
    usage,
  };
}
