import { describe, expect, it } from 'vitest';
import {
  describeToolCall,
  footer,
  progressMessage,
  formatQuestion,
  parseQuestion,
  splitMessage,
  threadName,
  variantFromThreadName,
} from '../../src/discord/format.js';

describe('splitMessage', () => {
  it('keeps short text in one chunk', () => {
    expect(splitMessage('  hello  ')).toEqual(['hello']);
  });

  it('splits on paragraph boundaries and respects the limit', () => {
    const para = 'x'.repeat(60);
    const text = Array.from({ length: 10 }, () => para).join('\n\n');
    const chunks = splitMessage(text, 200);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join('\n\n')).toBe(text);
    expect(chunks[0]).toBe([para, para, para].join('\n\n'));
  });

  it('hard-splits text without whitespace', () => {
    const chunks = splitMessage('y'.repeat(450), 200);
    expect(chunks.map((c) => c.length)).toEqual([196, 196, 58]);
  });

  it('closes and reopens code fences across chunks', () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const text = `Intro\n\`\`\`cpp\n${code}\n\`\`\`\nOutro`;
    const chunks = splitMessage(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(120);
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]).toMatch(/^```cpp\n/);
  });
});

describe('footer', () => {
  it('shortens GitHub URLs and commits', () => {
    expect(
      footer({
        model: 'qwen3',
        variant: 'standard',
        repoUrl: 'https://github.com/Atlantis-PBEM/Atlantis.git',
        commit: '63710e0532abcdef',
      }),
    ).toBe(
      '-# qwen3 · standard · Atlantis-PBEM/Atlantis@63710e0 · AI answer, may be wrong: check the cited sources',
    );
  });
});

describe('question header', () => {
  it('round-trips', () => {
    const content = formatQuestion('123', 'How does TACT work?\nSecond line');
    expect(content).toBe(
      'We are Borg!\n<@123> asked:\n**Question:** How does TACT work?\nSecond line\n[Accessing collective hive mind ... ]',
    );
    expect(parseQuestion(content)).toBe('How does TACT work?\nSecond line');
    // Starter messages posted before the Borg text was added still parse.
    expect(parseQuestion('<@123> asked:\n**Question:** Old question')).toBe('Old question');
    expect(parseQuestion('something else')).toBeUndefined();
  });
});

describe('threadName', () => {
  it('embeds the variant and fits in 100 chars', () => {
    const name = threadName(`What   is\n${'a'.repeat(200)}`, 'neworigins');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toMatch(/^What is a+… · neworigins$/);
    expect(variantFromThreadName(name)).toBe('neworigins');
    expect(variantFromThreadName(threadName('x · y', 'standard'))).toBe('standard');
    expect(variantFromThreadName('renamed by a moderator')).toBeUndefined();
  });
});

describe('describeToolCall', () => {
  it('describes each tool in player terms', () => {
    expect(describeToolCall('search_rules', '{"pattern":"tactics"}')).toBe(
      'Searching the rules for “tactics”',
    );
    expect(describeToolCall('read_rules', '{"section":"Combat"}')).toBe(
      'Reading the rules: “Combat”',
    );
    expect(describeToolCall('read_rules', '{}')).toBe('Reading the rules’ table of contents');
    expect(describeToolCall('search_code', '{"pattern":"S_TACTICS"}')).toBe(
      'Searching the code for “S_TACTICS”',
    );
    expect(describeToolCall('read_file', '{"path":"battle.cpp"}')).toBe('Reading `battle.cpp`');
    expect(describeToolCall('list_dir', '{}')).toBe('Browsing `.`');
    expect(describeToolCall('find_definition', '{"queries":["a","b","c","d","e"]}')).toBe(
      'Looking up a, b, c and 2 more',
    );
    expect(describeToolCall('find_definition', 'not json')).toBe('Looking up game data');
    expect(describeToolCall('other', '{}')).toBe('Using other');
  });
});

describe('progressMessage', () => {
  it('shows elapsed time and the latest steps', () => {
    expect(progressMessage([], 4_000)).toBe('🔎 Researching… (4s)');
    const steps = Array.from({ length: 7 }, (_, i) => `step ${i + 1}`);
    expect(progressMessage(steps, 125_000)).toBe(
      [
        '🔎 Researching… (2m 05s)',
        '-# … 2 earlier steps',
        ...steps.slice(2).map((s) => `-# ${s}`),
      ].join('\n'),
    );
  });

  it('shows the queue before research starts', () => {
    expect(progressMessage([], 0, 1)).toBe('⏳ Waiting for 1 question ahead of yours…');
    expect(progressMessage([], 0, 3)).toBe('⏳ Waiting for 3 questions ahead of yours…');
    expect(progressMessage(['s'], 0, 3)).toMatch(/^🔎/);
  });
});
