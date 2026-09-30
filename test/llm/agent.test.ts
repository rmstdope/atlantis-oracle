import { describe, expect, it } from 'vitest';
import {
  answerQuestion,
  FALLBACK_ANSWER,
  stripThinking,
  type AgentOptions,
} from '../../src/llm/agent.js';
import { defaultTools } from '../../src/tools/index.js';
import { callTools, fakeLlm, reply, type ScriptedReply } from '../helpers/fakeLlm.js';
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
    tools: defaultTools,
    toolContext: { root: FIXTURE_REPO },
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
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(llm.requests[0]!.tools).toHaveLength(4);
    expect(llm.requests[0]!.tool_choice).toBe('auto');
    expect(llm.requests[0]!.model).toBe('test-model');
  });

  it('runs tool calls and feeds results back', async () => {
    const { llm, promise } = run([
      callTools(['find_definition', { query: 'TACT' }]),
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
    expect(String(toolMessages[0]!.content)).toContain('SkillDefs[1] (enum S_TACTICS)');
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
      [callTools(['list_dir', {}]), callTools(['list_dir', {}]), reply('ok')],
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

describe('stripThinking', () => {
  it('handles a missing opening tag', () => {
    expect(stripThinking('reasoning here</think>\n\nThe answer')).toBe('The answer');
    expect(stripThinking('a <think>x</think> b <think>y</think> c')).toBe('a  b  c');
  });
});
