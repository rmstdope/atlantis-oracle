import OpenAI from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import type { LlmConfig } from '../config.js';

/** The one LLM call the bot needs. Tests substitute a scripted fake. */
export interface LlmClient {
  complete(
    params: ChatCompletionCreateParamsNonStreaming,
    signal?: AbortSignal,
  ): Promise<ChatCompletion>;
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  // Node's fetch gives up after 300s without response headers, whatever the SDK
  // timeout says; non-streaming responses from slow servers can take longer.
  const dispatcher = new Agent({
    headersTimeout: cfg.requestTimeoutMs,
    bodyTimeout: cfg.requestTimeoutMs,
  });
  const openai = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    timeout: cfg.requestTimeoutMs,
    maxRetries: cfg.maxRetries,
    fetch: undiciFetch as unknown as typeof fetch,
    fetchOptions: { dispatcher } as NonNullable<
      ConstructorParameters<typeof OpenAI>[0]
    >['fetchOptions'],
  });
  return {
    complete: (params, signal) => openai.chat.completions.create(params, { signal }),
  };
}
