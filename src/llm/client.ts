import OpenAI from 'openai';
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
  const openai = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    timeout: cfg.requestTimeoutMs,
    maxRetries: cfg.maxRetries,
  });
  return {
    complete: (params, signal) => openai.chat.completions.create(params, { signal }),
  };
}
