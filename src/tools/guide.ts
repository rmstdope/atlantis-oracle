import { z } from 'zod';
import { formatTopic, type ResolvedGuide, type ResolvedTopic } from '../guide/store.js';
import { defineTool, ToolError } from './types.js';

/** Scores how well a free-text query matches a topic, for inexact topic names. */
function score(topic: ResolvedTopic, words: string[]): number {
  const title = topic.title.toLowerCase();
  const body = `${topic.intro} ${topic.entries.map((e) => e.note).join(' ')}`.toLowerCase();
  return words.reduce((s, w) => s + (title.includes(w) ? 3 : body.includes(w) ? 1 : 0), 0);
}

export function lookupTopic(guide: ResolvedGuide, query: string): ResolvedTopic | undefined {
  const q = query.trim().toLowerCase();
  const exact = guide.topics.find((t) => t.title.toLowerCase() === q);
  if (exact) return exact;
  const partial = guide.topics.filter((t) => t.title.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const best = guide.topics.map((t) => ({ t, s: score(t, words) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s > 0 ? best.t : undefined;
}

export const topicIndex = (guide: ResolvedGuide) => guide.topics.map((t) => t.title).join('; ');

export const readGuide = defineTool({
  name: 'read_guide',
  description:
    'Read the code guide: for a game topic, the functions, tables and constants that decide it, ' +
    'as path:line pointers to read with read_file. Without a topic it lists all topics. ' +
    'Use it before search_code.',
  schema: z.object({
    topic: z.string().optional().describe('Topic title or a few words, e.g. "spoils"'),
  }),
  async handler(args, ctx) {
    const guide = ctx.guide;
    if (!guide) throw new ToolError('No code guide is available; use search_code and read_file.');
    if (!args.topic?.trim()) {
      return guide.topics.map((t) => `- ${t.title}: ${t.intro}`).join('\n');
    }
    const topic = lookupTopic(guide, args.topic);
    if (!topic) {
      throw new ToolError(
        `No guide topic matches "${args.topic}". Topics: ${topicIndex(guide)}. ` +
          'If none fits, use search_code.',
      );
    }
    return formatTopic(topic);
  },
});
