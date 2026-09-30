import { describe, expect, it } from 'vitest';
import {
  footer,
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
    expect(content).toContain('<@123>');
    expect(parseQuestion(content)).toBe('How does TACT work?\nSecond line');
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
