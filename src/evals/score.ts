import { z } from 'zod';

export const evalQuestionSchema = z.object({
  id: z.string().min(1),
  tier: z.enum(['hard', 'medium', 'regression']),
  variant: z.string().min(1),
  question: z.string().min(1),
  /** Regexes (case-insensitive) for facts a good answer states. */
  mustMention: z.array(z.string()).min(1),
  /** Regexes for known wrong claims. */
  mustNotMention: z.array(z.string()),
  notes: z.string(),
});

export type EvalQuestion = z.infer<typeof evalQuestionSchema>;

export interface Score {
  /** Share of mustMention patterns found, 0..1. */
  recall: number;
  missing: string[];
  forbidden: string[];
  pass: boolean;
}

/** Models write minus signs and hyphens as various Unicode dashes; patterns use '-'. */
const normalize = (text: string) => text.replace(/[\u2010-\u2015\u2212]/g, '-');

/**
 * Forbidden in every answer: the model talking about its own process, which
 * means reasoning or a review leaked into what the player sees.
 */
export const META_TALK = [
  '\\b(my|the) draft\\b',
  '\\blet me (re-?)?(review|verify|check|recompute|redo)\\b',
  '\\b(got|was) cut off\\b',
  '\\bfrom the tool results\\b',
];

export function scoreAnswer(q: EvalQuestion, answer: string): Score {
  const text = normalize(answer);
  const test = (p: string) => new RegExp(p, 'i').test(text);
  const missing = q.mustMention.filter((p) => !test(p));
  const forbidden = [...q.mustNotMention, ...META_TALK].filter(test);
  const recall = (q.mustMention.length - missing.length) / q.mustMention.length;
  return { recall, missing, forbidden, pass: missing.length === 0 && forbidden.length === 0 };
}
