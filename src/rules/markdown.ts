import { NodeHtmlMarkdown } from 'node-html-markdown';

export interface Heading {
  level: number;
  text: string;
  /** 1-based line in the Markdown. */
  line: number;
}

export function rulesHtmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html)
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Heading text without Markdown escapes and trailing colons, e.g. "Factions". */
function cleanHeading(raw: string): string {
  return raw
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s*:\s*$/, '')
    .trim();
}

export function extractHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[2]!.trim())
      headings.push({ level: m[1]!.length, text: cleanHeading(m[2]!), line: i + 1 });
  });
  return headings;
}
