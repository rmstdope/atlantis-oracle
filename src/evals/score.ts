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

export function scoreAnswer(q: EvalQuestion, answer: string): Score {
  const test = (p: string) => new RegExp(p, 'i').test(answer);
  const missing = q.mustMention.filter((p) => !test(p));
  const forbidden = q.mustNotMention.filter(test);
  const recall = (q.mustMention.length - missing.length) / q.mustMention.length;
  return { recall, missing, forbidden, pass: missing.length === 0 && forbidden.length === 0 };
}
