import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
} from 'openai/resources/chat/completions';
import type { LlmClient } from '../../src/llm/client.js';

export interface ScriptedReply {
  content?: string | null;
  toolCalls?: { name: string; args: string; id?: string }[];
}

export function reply(content: string): ScriptedReply {
  return { content };
}

export function callTools(...calls: [name: string, args: unknown][]): ScriptedReply {
  return {
    content: null,
    toolCalls: calls.map(([name, args], i) => ({
      name,
      args: typeof args === 'string' ? args : JSON.stringify(args),
      id: `call_${i}`,
    })),
  };
}

/** An LlmClient that returns scripted replies in order and records every request. */
export function fakeLlm(script: ScriptedReply[]): LlmClient & {
  requests: ChatCompletionCreateParamsNonStreaming[];
} {
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  return {
    requests,
    async complete(params) {
      // Snapshot: the agent keeps appending to its message array.
      requests.push(structuredClone(params));
      const next = script.shift();
      if (!next) throw new Error('fakeLlm: script exhausted');
      const tool_calls: ChatCompletionMessageFunctionToolCall[] | undefined = next.toolCalls?.map(
        (c) => ({
          id: c.id ?? '',
          type: 'function',
          function: { name: c.name, arguments: c.args },
        }),
      );
      return {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: params.model,
        choices: [
          {
            index: 0,
            finish_reason: tool_calls ? 'tool_calls' : 'stop',
            logprobs: null,
            message: {
              role: 'assistant',
              content: next.content ?? null,
              refusal: null,
              tool_calls,
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } satisfies ChatCompletion;
    },
  };
}
