import { describe, expect, it } from 'vitest';
import { extractHeadings, rulesHtmlToMarkdown } from '../../src/rules/markdown.js';

describe('rulesHtmlToMarkdown', () => {
  it('keeps headings, paragraphs and tables', () => {
    const md = rulesHtmlToMarkdown(
      '<h2>Skills</h2><p>Study hard.</p><p></p><p></p><table><tr><th>A</th></tr><tr><td>1</td></tr></table>',
    );
    expect(md).toContain('## Skills');
    expect(md).toContain('Study hard.');
    expect(md).toMatch(/\| A +\|/);
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe('extractHeadings', () => {
  it('cleans escapes and colons and ignores code fences', () => {
    const lines = [
      '# Rules',
      'text',
      '### Factions:',
      '```',
      '# not a heading',
      '```',
      '#### FACTION \\[type\\]',
    ];
    expect(extractHeadings(lines)).toEqual([
      { level: 1, text: 'Rules', line: 1 },
      { level: 3, text: 'Factions', line: 3 },
      { level: 4, text: 'FACTION [type]', line: 7 },
    ]);
  });
});
