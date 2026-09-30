import { describe, expect, it } from 'vitest';
import {
  answerQuestion,
  AgentError,
  FALLBACK_ANSWER,
  PLAN_PROMPT,
  REVIEW_PROMPT,
  stripThinking,
  type AgentOptions,
} from '../../src/llm/agent.js';
import { codeTools, defaultTools, type Tool } from '../../src/tools/index.js';
import { defineTool } from '../../src/tools/types.js';
import { z } from 'zod';
import { callTools, fail, fakeLlm, reply, type ScriptedReply } from '../helpers/fakeLlm.js';
import { FIXTURE_REPO } from '../helpers/fixture.js';

function run(script: ScriptedReply[], overrides: Partial<AgentOptions> = {}) {
  const llm = fakeLlm(script);
  const promise = answerQuestion({
    llm,
    model: 'test-model',
    temperature: 0.2,
    maxIterations: 5,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'What does TACT cost?' },
    ],
    tools: codeTools,
    toolContext: { root: FIXTURE_REPO, variant: 'standard' },
    ...overrides,
  });
  return { llm, promise };
}

describe('answerQuestion', () => {
  it('returns a direct answer', async () => {
    const { llm, promise } = run([reply('It costs 200.')]);
    const r = await promise;
    expect(r).toMatchObject({
      text: 'It costs 200.',
      iterations: 1,
      hitIterationCap: false,
      toolCalls: [],
    });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 0 });
    expect(llm.requests[0]!.tools).toHaveLength(4);
    expect(llm.requests[0]!.tool_choice).toBe('auto');
    expect(llm.requests[0]!.model).toBe('test-model');
  });

  it('runs tool calls and feeds results back', async () => {
    const { llm, promise } = run([
      callTools(['find_definition', { queries: ['TACT'] }]),
      callTools(
        ['search_code', { pattern: 'S_TACTICS', glob: '*/extra.cpp', context: 0 }],
        ['read_file', { path: 'standard/rules.cpp', start_line: 4, end_line: 4 }],
      ),
      reply('Tactics costs 200 silver per month (gamedata.cpp:48).'),
    ]);
    const r = await promise;
    expect(r.iterations).toBe(3);
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ['find_definition', true],
      ['search_code', true],
      ['read_file', true],
    ]);

    const last = llm.requests[2]!.messages;
    const toolMessages = last.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]).toMatchObject({ tool_call_id: 'call_0' });
    expect(String(toolMessages[0]!.content)).toContain('SkillDefs[1] S_TACTICS');
    expect(String(toolMessages[1]!.content)).toContain('standard/extra.cpp:4:');
    expect(toolMessages[2]).toMatchObject({ tool_call_id: 'call_1' });

    // Each assistant tool-call turn precedes its tool results.
    const roles = last.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'tool']);
  });

  it('returns tool errors to the model instead of throwing', async () => {
    const { llm, promise } = run([
      callTools(['read_file', '{"path": broken'], ['no_such_tool', {}]),
      reply('Could not find it.'),
    ]);
    const r = await promise;
    expect(r.toolCalls.every((c) => !c.ok)).toBe(true);
    const tools = llm.requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(String(tools[0]!.content)).toMatch(/not valid JSON/);
    expect(String(tools[1]!.content)).toMatch(/unknown tool/);
  });

  it('generates ids for tool calls that lack one', async () => {
    const { llm, promise } = run([
      { toolCalls: [{ name: 'list_dir', args: '{}', id: '' }] },
      reply('done'),
    ]);
    await promise;
    const msgs = llm.requests[1]!.messages;
    const assistant = msgs.find((m) => m.role === 'assistant');
    const tool = msgs.find((m) => m.role === 'tool');
    const id = assistant && 'tool_calls' in assistant ? assistant.tool_calls?.[0]?.id : undefined;
    expect(id).toMatch(/^call_/);
    expect(tool).toMatchObject({ tool_call_id: id });
  });

  it('forces an answer without tools when the iteration cap is hit', async () => {
    const loop = () => callTools(['list_dir', {}]);
    const { llm, promise } = run([loop(), loop(), reply('Best effort answer.')], {
      maxIterations: 2,
    });
    const r = await promise;
    expect(r).toMatchObject({ text: 'Best effort answer.', hitIterationCap: true, iterations: 3 });
    const final = llm.requests[2]!;
    expect(final.tools).toBeUndefined();
    expect(final.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringMatching(/Answer the question now/),
    });
  });

  it('stops running tools once the output budget is spent', async () => {
    const { llm, promise } = run(
      [callTools(['list_dir', {}]), callTools(['list_dir', { path: 'standard' }]), reply('ok')],
      { toolOutputBudget: 10 },
    );
    const r = await promise;
    expect(r.toolCalls.map((c) => c.ok)).toEqual([true, false]);
    const tools = llm.requests[2]!.messages.filter((m) => m.role === 'tool');
    expect(String(tools[1]!.content)).toMatch(/budget exhausted/);
  });

  it('strips thinking and falls back on empty answers', async () => {
    expect((await run([reply('<think>hmm</think>\nAnswer.')]).promise).text).toBe('Answer.');
    expect((await run([reply('<think>only thoughts</think>')]).promise).text).toBe(FALLBACK_ANSWER);
    expect((await run([{ content: null }]).promise).text).toBe(FALLBACK_ANSWER);
  });

  it('propagates LLM failures', async () => {
    await expect(run([]).promise).rejects.toThrow(/script exhausted/);
  });
});

describe('plan and review steps', () => {
  const phases: string[] = [];
  const onPhase = (p: string) => phases.push(p);

  it('plans without tools, researches, and keeps an approved draft', async () => {
    phases.length = 0;
    const { llm, promise } = run(
      [
        reply('- cost of TACT: gamedata'),
        callTools(['find_definition', { queries: ['TACT'] }]),
        reply('Tactics costs 200.'),
        reply('APPROVED'),
      ],
      { planStep: true, reviewStep: true, onPhase },
    );
    const r = await promise;
    expect(r).toMatchObject({ text: 'Tactics costs 200.', review: 'approved', iterations: 2 });
    expect(phases).toEqual(['planning', 'researching', 'reviewing']);
    expect(llm.requests[0]!.tools).toBeUndefined();
    expect(llm.requests[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: PLAN_PROMPT });
    expect(llm.requests[1]!.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '- cost of TACT: gamedata' },
      { role: 'user', content: expect.stringMatching(/carry out the plan/) },
    ]);
    expect(llm.requests[1]!.tools).toHaveLength(4);
    const review = llm.requests[3]!;
    expect(review.tools).toBeUndefined();
    expect(review.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'Tactics costs 200.' },
      { role: 'user', content: REVIEW_PROMPT },
    ]);
  });

  it('uses a revised answer from the review', async () => {
    const { promise } = run([reply('draft'), reply('<think>hmm</think>Better answer.')], {
      reviewStep: true,
    });
    expect(await promise).toMatchObject({ text: 'Better answer.', review: 'revised' });
  });

  it('researches once more when the review finds gaps', async () => {
    phases.length = 0;
    const { llm, promise } = run(
      [
        reply('draft without numbers'),
        reply('RESEARCH: the study cost of tactics'),
        callTools(['find_definition', { queries: ['TACT'] }]),
        reply('Final: 200 silver.'),
      ],
      { reviewStep: true, onPhase },
    );
    const r = await promise;
    expect(r).toMatchObject({ text: 'Final: 200 silver.', review: 'researched', iterations: 3 });
    expect(phases).toEqual(['researching', 'reviewing', 'researching']);
    expect(llm.requests[2]!.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringMatching(/^Research what is missing: the study cost of tactics/),
    });
    expect(llm.requests).toHaveLength(4); // no second review
  });

  it('skips an empty plan and keeps the draft when the review is empty', async () => {
    const { llm, promise } = run([reply(''), reply('answer'), reply('')], {
      planStep: true,
      reviewStep: true,
    });
    expect(await promise).toMatchObject({ text: 'answer', review: 'approved' });
    expect(llm.requests[1]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('failure recovery', () => {
  it('answers from the research so far when a call fails mid-research', async () => {
    const longOutput = defineTool({
      name: 'read_everything',
      description: 'long output',
      schema: z.object({}),
      handler: async () => 'x'.repeat(5000),
    }) as Tool;
    const { llm, promise } = run(
      [callTools(['read_everything', {}]), fail(), reply('Answer from what was found.')],
      { tools: [longOutput] },
    );
    const r = await promise;
    expect(r).toMatchObject({ text: 'Answer from what was found.', recovered: true });
    const last = llm.requests[2]!;
    expect(last.tools).toBeUndefined();
    const tool = last.messages.find((m) => m.role === 'tool');
    // Long tool output is shortened for the recovery call.
    expect(String(tool!.content)).toMatch(/\[shortened\]$/);
    expect(String(tool!.content).length).toBeLessThan(1600);
  });

  it('turns a response without choices into an error the recovery can handle', async () => {
    const bad = { raw: { error: { message: 'model busy' } } };
    await expect(run([bad]).promise).rejects.toThrow(
      'LLM response contained no message: model busy',
    );
    const { promise } = run([callTools(['list_dir', {}]), bad, reply('Recovered.')]);
    expect(await promise).toMatchObject({ text: 'Recovered.', recovered: true });
  });

  it('fails when nothing has been researched yet', async () => {
    await expect(run([fail('boom')]).promise).rejects.toThrow('boom');
  });

  it('reports the original error when recovery also fails', async () => {
    const { promise } = run([callTools(['list_dir', {}]), fail('first'), fail('second')]);
    await expect(promise).rejects.toThrow('first');
  });

  it('skips a failed plan and keeps the draft when the review fails', async () => {
    const { promise } = run([fail(), reply('draft'), fail()], { planStep: true, reviewStep: true });
    expect(await promise).toMatchObject({ text: 'draft', review: 'approved' });
  });

  it('sends top_p only when configured', async () => {
    const a = run([reply('x')]);
    await a.promise;
    expect(a.llm.requests[0]).not.toHaveProperty('top_p');
    const b = run([reply('x')], { topP: 0.95 });
    await b.promise;
    expect(b.llm.requests[0]!.top_p).toBe(0.95);
  });
});

describe('diagnostics', () => {
  it('records every LLM call with its purpose and token counts', async () => {
    const { promise } = run(
      [reply('plan'), callTools(['list_dir', {}]), reply('answer'), reply('APPROVED')],
      { planStep: true, reviewStep: true },
    );
    const r = await promise;
    expect(r.llmCalls.map((c) => c.purpose)).toEqual(['plan', 'research', 'research', 'review']);
    expect(r.llmCalls[0]).toMatchObject({ promptTokens: 10, completionTokens: 5 });
    expect(r.llmCalls.every((c) => c.error === undefined)).toBe(true);
  });

  it('throws an AgentError carrying the work done before the failure', async () => {
    const { promise } = run([callTools(['list_dir', {}]), fail('first'), fail('second')]);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    const partial = (err as AgentError).partial;
    expect(partial.toolCalls.map((c) => c.name)).toEqual(['list_dir']);
    expect(partial.llmCalls.map((c) => [c.purpose, c.error])).toEqual([
      ['research', undefined],
      ['research', 'first'],
      ['answer', 'second'],
    ]);
  });

  it('keeps the draft when the extra research requested by the review fails', async () => {
    const { promise } = run([reply('draft'), reply('RESEARCH: more'), fail(), fail()], {
      reviewStep: true,
    });
    expect(await promise).toMatchObject({ text: 'draft', review: 'researched' });
  });
});

describe('runaway generations and round budget', () => {
  it('sends max_tokens and asks again once when a reply is cut off empty', async () => {
    const { llm, promise } = run(
      [{ content: '<think>loooong', truncated: true }, reply('Short answer.')],
      { maxTokens: 4096 },
    );
    const r = await promise;
    expect(r.text).toBe('Short answer.');
    expect(llm.requests[0]!.max_tokens).toBe(4096);
    expect(llm.requests[1]!.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringMatching(/cut off/),
    });
    expect(r.llmCalls[0]!.truncated).toBe(true);
  });

  it('asks again when an answer is cut off, and never sends cut-off text', async () => {
    const { llm, promise } = run([
      { content: 'The army needs 12 men because 280 / (1', truncated: true },
      { content: 'The user wants me to answer... let me synthesize', truncated: true },
    ]);
    expect((await promise).text).toBe(FALLBACK_ANSWER);
    expect(llm.requests[1]!.messages.at(-1)).toMatchObject({
      content: expect.stringMatching(/cut off/),
    });
  });

  it('does not send a cut-off forced answer', async () => {
    const { promise } = run(
      [callTools(['list_dir', {}]), { content: 'The user wants me to...', truncated: true }],
      { maxIterations: 1 },
    );
    expect(await promise).toMatchObject({ text: FALLBACK_ANSWER, hitIterationCap: true });
  });

  it('keeps the draft when the review is cut off', async () => {
    const { promise } = run(
      [
        reply('Clean draft.'),
        { content: 'Let me review my draft. I was in the middle of', truncated: true },
      ],
      { reviewStep: true },
    );
    expect(await promise).toMatchObject({ text: 'Clean draft.', review: 'approved' });
  });

  it('warns the model when few research rounds remain', async () => {
    const calls = Array.from({ length: 6 }, (_, i) =>
      callTools(['list_dir', { path: i % 2 ? 'standard' : 'neworigins' }]),
    );
    const { llm, promise } = run([...calls, reply('done')], { maxIterations: 6 });
    await promise;
    const tools = llm.requests
      .at(-1)!
      .messages.filter((m) => m.role === 'tool')
      .map((m) => String(m.content));
    expect(tools[0]).not.toMatch(/Research round/);
    expect(tools[1]).toMatch(
      /\[Research round 2 of 6: 4 left\. Start concluding and answer soon\.\]$/,
    );
    expect(tools[4]).toMatch(/Research round 5 of 6: 1 left/);
    expect(tools[5]).not.toMatch(/Research round/);
  });
});

describe('loop guard', () => {
  it('answers repeated calls with a pointer to the earlier step', async () => {
    const { llm, promise } = run([
      callTools(['read_file', { path: 'standard/rules.cpp', start_line: 1, end_line: 11 }]),
      callTools(
        ['read_file', { path: 'standard/rules.cpp', start_line: 4, end_line: 5 }],
        ['list_dir', {}],
      ),
      callTools(['list_dir', {}]),
      reply('done'),
    ]);
    const r = await promise;
    expect(r.toolCalls.map((c) => [c.name, !!c.repeat])).toEqual([
      ['read_file', false],
      ['read_file', true],
      ['list_dir', false],
      ['list_dir', true],
    ]);
    const tools = llm.requests[3]!.messages.filter((m) => m.role === 'tool').map((m) =>
      String(m.content),
    );
    expect(tools[1]).toBe(
      'Already shown: this read_file request is covered by the result of step 1. Use that result instead of requesting it again, or ask for something new.',
    );
    expect(tools[3]).toMatch(/covered by the result of step 3/);
  });

  it('does not remember failed calls', async () => {
    const { promise } = run([
      callTools(['read_file', { path: 'nope.cpp' }]),
      callTools(['read_file', { path: 'nope.cpp' }]),
      reply('done'),
    ]);
    expect((await promise).toolCalls.map((c) => [c.ok, !!c.repeat])).toEqual([
      [false, false],
      [false, false],
    ]);
  });
});

describe('rules-first gating', () => {
  // A stand-in rules tool so the gating can be tested without a rules store.
  const fakeRules = defineTool({
    name: 'search_rules',
    description: 'rules',
    schema: z.object({ pattern: z.string() }),
    handler: async ({ pattern }) => `rules hit for ${pattern}`,
  }) as Tool;
  const tools = [fakeRules, ...codeTools];
  const names = (req: { tools?: unknown[] }) =>
    (req.tools ?? []).map((t) => (t as { function: { name: string } }).function.name);

  it('offers only the first tools until one has been used', async () => {
    const { llm, promise } = run(
      [
        callTools(['search_rules', { pattern: 'tactics' }]),
        callTools(['search_code', { pattern: 'S_TACTICS', context: 0 }]),
        reply('done'),
      ],
      { tools, firstTools: ['search_rules'] },
    );
    const r = await promise;
    expect(names(llm.requests[0]!)).toEqual(['search_rules']);
    expect(names(llm.requests[1]!)).toEqual([
      'search_rules',
      'search_code',
      'read_file',
      'list_dir',
      'find_definition',
    ]);
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ['search_rules', true],
      ['search_code', true],
    ]);
  });

  it('refuses code tools called before the rules', async () => {
    const { llm, promise } = run(
      [
        callTools(['search_code', { pattern: 'x' }]),
        callTools(['search_rules', { pattern: 'x' }]),
        reply('ok'),
      ],
      { tools, firstTools: ['search_rules'] },
    );
    const r = await promise;
    expect(r.toolCalls.map((c) => c.ok)).toEqual([false, true]);
    const refusal = llm.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(String(refusal!.content)).toMatch(/check the game rules first \(search_rules\)/);
    expect(names(llm.requests[1]!)).toEqual(['search_rules']);
  });

  it('reminds the model once when it answers without looking anything up', async () => {
    const { llm, promise } = run([reply('from memory'), reply('still from memory')], {
      tools,
      firstTools: ['search_rules'],
    });
    const r = await promise;
    expect(r.text).toBe('still from memory');
    expect(llm.requests[1]!.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'from memory' },
      { role: 'user', content: expect.stringMatching(/look the question up in the game rules/) },
    ]);
  });

  it('does not gate when the first tools are not available', async () => {
    const { llm, promise } = run([reply('answer')], {
      tools: codeTools,
      firstTools: ['search_rules'],
    });
    expect((await promise).text).toBe('answer');
    expect(names(llm.requests[0]!)).toHaveLength(4);
    expect(defaultTools.length).toBe(6);
  });
});

describe('stripThinking', () => {
  it('handles a missing opening tag', () => {
    expect(stripThinking('reasoning here</think>\n\nThe answer')).toBe('The answer');
    expect(stripThinking('a <think>x</think> b <think>y</think> c')).toBe('a  b  c');
    expect(stripThinking('Answer.\n<think>cut off mid-reasoning')).toBe('Answer.');
    expect(stripThinking('<think>never closed')).toBe('');
  });
});
