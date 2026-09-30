import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { evalQuestionSchema, scoreAnswer, type EvalQuestion } from '../../src/evals/score.js';

const q: EvalQuestion = {
  id: 'x',
  tier: 'hard',
  variant: 'standard',
  question: '?',
  mustMention: ['\\b280\\b', 'hellfire'],
  mustNotMention: ['must enter the lair'],
  notes: '',
};

describe('scoreAnswer', () => {
  it('scores recall case-insensitively', () => {
    expect(scoreAnswer(q, 'It has 280 hits and casts HELLFIRE.')).toEqual({
      recall: 1,
      missing: [],
      forbidden: [],
      pass: true,
    });
    expect(scoreAnswer(q, 'It has 2800 hits.')).toMatchObject({ recall: 0, pass: false });
  });

  it('treats Unicode dashes as hyphens', () => {
    const dash: EvalQuestion = { ...q, mustMention: ['-2 to attack'] };
    for (const d of ['\u2011', '\u2013', '\u2212']) {
      expect(scoreAnswer(dash, `storm gives ${d}2 to attack`).pass).toBe(true);
    }
  });

  it('fails answers that leak reasoning or review talk', () => {
    const s = scoreAnswer(q, 'Let me review my draft. 280 hits, hellfire.');
    expect(s).toMatchObject({ recall: 1, pass: false });
    expect(s.forbidden.length).toBeGreaterThan(0);
    expect(
      scoreAnswer(q, 'The Balrog has 280 hits and casts hellfire; check the rules.').pass,
    ).toBe(true);
  });

  it('fails on forbidden claims even with full recall', () => {
    const s = scoreAnswer(q, '280, hellfire, and you Must Enter The Lair.');
    expect(s).toMatchObject({ recall: 1, forbidden: ['must enter the lair'], pass: false });
  });
});

describe('evals/questions.json', () => {
  it('is valid and every pattern compiles', async () => {
    const questions = z
      .array(evalQuestionSchema)
      .parse(JSON.parse(await readFile('evals/questions.json', 'utf8')));
    expect(new Set(questions.map((x) => x.id)).size).toBe(questions.length);
    for (const x of questions) {
      for (const p of [...x.mustMention, ...x.mustNotMention])
        expect(() => new RegExp(p, 'i')).not.toThrow();
    }
  });
});
