import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { runTool, toOpenAITools, type Tool, type ToolContext } from '../tools/index.js';
import type { LlmClient } from './client.js';

export interface ToolCallRecord {
  name: string;
  args: string;
  ok: boolean;
  ms: number;
}

export interface AgentResult {
  text: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  hitIterationCap: boolean;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
}

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
  signal?: AbortSignal;
  onToolCall?: (name: string, args: string) => void;
}

export const FALLBACK_ANSWER =
  "Sorry, I couldn't come up with an answer this time. Try rephrasing the question.";

const RULES_FIRST_PROMPT =
  'Before answering, look the question up in the game rules with the rules tools. ' +
  'If the rules do not settle it, you can research the code afterwards.';

const FORCE_ANSWER_PROMPT =
  'You have used all available research steps. Answer the question now using only what you have ' +
  'found so far, and say clearly what remains uncertain.';

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

  const result = (
    content: string | null | undefined,
    iterations: number,
    hitIterationCap: boolean,
  ) => ({
    text: stripThinking(content ?? '') || FALLBACK_ANSWER,
    toolCalls,
    iterations,
    hitIterationCap,
    usage,
  });

  for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
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
      return result(message.content, iteration, false);
    }

    messages.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: calls,
    });

    for (const call of calls) {
      opts.onToolCall?.(call.function.name, call.function.arguments);
      const started = Date.now();
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
      toolCalls.push({
        name: call.function.name,
        args: call.function.arguments,
        ok,
        ms: Date.now() - started,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  messages.push({ role: 'user', content: FORCE_ANSWER_PROMPT });
  const final = await complete(false);
  return result(final.content, opts.maxIterations + 1, true);
}
