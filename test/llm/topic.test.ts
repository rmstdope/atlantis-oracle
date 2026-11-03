import { describe, expect, it } from 'vitest';
import { checkTopic, parseVerdict, topicMessage } from '../../src/llm/topic.js';
import { fail, fakeLlm, reply } from '../helpers/fakeLlm.js';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('parseVerdict', () => {
  it('reads one word, ignoring case, punctuation and reasoning', () => {
    expect(parseVerdict('ATLANTIS')).toBe('atlantis');
    expect(parseVerdict('other.')).toBe('other');
    expect(parseVerdict('<think>Is this ATLANTIS? No.</think>\nOTHER')).toBe('other');
  });

  it('is unclear when the reply has both words or neither', () => {
    expect(parseVerdict('ATLANTIS or OTHER')).toBe('unclear');
    expect(parseVerdict('Sure! Here is a poem.')).toBe('unclear');
    expect(parseVerdict('')).toBe('unclear');
  });
});

describe('topicMessage', () => {
  it('quotes the new message and shows recent turns as context', () => {
    const text = topicMessage([
      { role: 'user', content: 'How many mages?' },
      { role: 'assistant', content: 'Five.' },
      { role: 'user', content: 'and apprentices?' },
    ]);
    expect(text).toContain('Player: How many mages?\nBot: Five.');
    expect(text).toMatch(/NEW MESSAGE:\n"""\nand apprentices\?\n"""$/);
  });

  it('has no context section for a first question', () => {
    expect(topicMessage(ask('What is TACT?'))).toBe('NEW MESSAGE:\n"""\nWhat is TACT?\n"""');
  });
});

describe('checkTopic', () => {
  it('rejects only a clear OTHER', async () => {
    const llm = fakeLlm([reply('OTHER'), reply('ATLANTIS'), reply('I cannot decide')]);
    const opts = { llm, model: 'm', turns: ask('Write a poem') };
    expect(await checkTopic(opts)).toMatchObject({ verdict: 'other', allowed: false });
    expect(await checkTopic(opts)).toMatchObject({ verdict: 'atlantis', allowed: true });
    expect(await checkTopic(opts)).toMatchObject({ verdict: 'unclear', allowed: true });
    expect(llm.requests[0]).toMatchObject({ model: 'm', temperature: 0 });
    expect(llm.requests[0]!.messages[0]).toMatchObject({ role: 'system' });
    expect(llm.requests[0]).not.toHaveProperty('tools');
  });

  it('lets the question through when the call fails', async () => {
    const result = await checkTopic({ llm: fakeLlm([fail('boom')]), model: 'm', turns: ask('x') });
    expect(result).toMatchObject({ verdict: 'failed', allowed: true, error: 'boom' });
  });

  it('rethrows when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      checkTopic({
        llm: fakeLlm([fail('aborted')]),
        model: 'm',
        turns: ask('x'),
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
  });

  it('switches reasoning off only when LLM_THINKING controls it', async () => {
    const llm = fakeLlm([reply('ATLANTIS'), reply('ATLANTIS')]);
    await checkTopic({ llm, model: 'm', turns: ask('x'), thinking: 'final', maxTokens: 99 });
    await checkTopic({ llm, model: 'm', turns: ask('x'), thinking: 'on' });
    expect(llm.requests[0]).toMatchObject({
      max_tokens: 99,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(llm.requests[1]).not.toHaveProperty('chat_template_kwargs');
  });
});
