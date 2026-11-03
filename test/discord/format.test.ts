import { describe, expect, it } from 'vitest';
import {
  describeToolCall,
  footer,
  progressMessage,
  formatIssueFiled,
  formatRelease,
  formatQuestion,
  parseAsker,
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
      '-# qwen3 · standard · Atlantis-PBEM/Atlantis@63710e0 · We are not infallible. Verify the cited sources.',
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
      'Scanning the rules for “tactics”',
    );
    expect(describeToolCall('read_rules', '{"section":"Combat"}')).toBe(
      'Assimilating rules: “Combat”',
    );
    expect(describeToolCall('read_rules', '{}')).toBe('Assimilating the rules’ table of contents');
    expect(describeToolCall('search_code', '{"pattern":"S_TACTICS"}')).toBe(
      'Scanning the code for “S_TACTICS”',
    );
    expect(describeToolCall('read_file', '{"path":"battle.cpp"}')).toBe(
      'Assimilating `battle.cpp`',
    );
    expect(describeToolCall('list_dir', '{}')).toBe('Surveying `.`');
    expect(describeToolCall('find_definition', '{"queries":["a","b","c","d","e"]}')).toBe(
      'Retrieving a, b, c and 2 more from the hive',
    );
    expect(describeToolCall('find_definition', 'not json')).toBe(
      'Retrieving game data from the hive',
    );
    expect(describeToolCall('other', '{}')).toBe('Engaging other');
  });
});

describe('progressMessage', () => {
  it('shows elapsed time and the latest steps', () => {
    expect(progressMessage([], 4_000)).toBe('🟩 Assimilating knowledge… (4s)');
    const steps = Array.from({ length: 7 }, (_, i) => `step ${i + 1}`);
    expect(progressMessage(steps, 125_000)).toBe(
      [
        '🟩 Assimilating knowledge… (2m 05s)',
        '-# … 2 earlier steps',
        ...steps.slice(2).map((s) => `-# ${s}`),
      ].join('\n'),
    );
  });

  it('shows the queue before research starts', () => {
    expect(progressMessage([], 0, 1)).toBe('⏳ Your query is queued. 1 drone ahead of you…');
    expect(progressMessage([], 0, 3)).toBe('⏳ Your query is queued. 3 drones ahead of you…');
    expect(progressMessage(['s'], 0, 3)).toMatch(/^🟩/);
  });
});

describe('formatIssueFiled', () => {
  it('shows the reporter, the first line and the link', () => {
    expect(formatIssueFiled('bug', '42', 'Wrong upkeep\nmore detail', 'https://gh/i/7')).toBe(
      '<@42> reported an anomaly. It has been assimilated.\n> Wrong upkeep\n<https://gh/i/7>',
    );
  });

  it('words wishes differently', () => {
    expect(formatIssueFiled('wish', '42', 'Dark mode', 'u')).toBe(
      '<@42> submitted a wish. Your distinctiveness will be added to our own.\n> Dark mode\n<u>',
    );
  });

  it('shortens a long first line', () => {
    const line = formatIssueFiled('bug', '42', 'x'.repeat(300), 'u').split('\n')[1]!;
    expect(line).toBe(`> ${'x'.repeat(99)}…`);
  });
});

describe('formatRelease', () => {
  const hud = { repo: 'rmstdope/atlantis-hud', siteUrl: 'https://atlantis-hud.rmstdope.eu' };
  const release = {
    tag: 'v1.4.0',
    name: 'v1.4.0',
    url: 'https://github.com/rmstdope/atlantis-hud/releases/tag/v1.4.0',
    publishedAt: '2026-10-30T12:00:00Z',
    notes: '## Changes\r\n- Dark mode<!-- hidden -->\r\n\r\n\r\n\r\n- Faster map',
  };

  it('shows version, date, links and notes', () => {
    expect(formatRelease(release, hud)).toBe(
      [
        'The latest assimilation of **atlantis-hud**: **v1.4.0** · released <t:1793361600:D>',
        'Release: <https://github.com/rmstdope/atlantis-hud/releases/tag/v1.4.0>',
        'atlantis-hud: <https://atlantis-hud.rmstdope.eu>',
        '',
        '## Changes\n- Dark mode\n\n- Faster map',
      ].join('\n'),
    );
  });

  it('turns headings into ones Discord renders', () => {
    const notes = 'What is new\n===========\n\nFixes\n-----\n- one\n\n#### Details\n---\nend';
    expect(
      formatRelease({ ...release, notes }, hud)
        .split('\n\n')
        .slice(1)
        .join('\n\n'),
    ).toBe('## What is new\n\n### Fixes\n- one\n\n### Details\n---\nend');
  });

  it('names the tag next to a release title', () => {
    expect(formatRelease({ ...release, name: 'Autumn update' }, hud)).toContain(
      '**Autumn update (v1.4.0)**',
    );
  });

  it('cuts long notes and links the full text', () => {
    const notes = Array.from({ length: 300 }, (_, i) => `- change ${i}`).join('\n');
    const text = formatRelease({ ...release, notes }, hud);
    expect(text.length).toBeLessThan(1900);
    expect(text).toMatch(/- change \d+\n… \[full release notes\]\(<https:.*v1\.4\.0>\)$/);
  });

  it('says when there are no notes', () => {
    expect(formatRelease({ ...release, notes: '' }, hud)).toContain('No release notes');
  });
});

describe('parseAsker', () => {
  it('finds the asker in the question header, not a mention inside the question', () => {
    expect(parseAsker(formatQuestion('123', 'Does <@999> win against a dragon?'))).toBe('123');
    expect(parseAsker('no mention')).toBeUndefined();
  });
});

describe('formatQuestion', () => {
  it('fits one Discord message however long the (defanged) question is', () => {
    const header = formatQuestion('123', 'x'.repeat(5000));
    expect(header.length).toBeLessThanOrEqual(2000);
    expect(parseQuestion(header)).toMatch(/^x+…$/);
  });
});
