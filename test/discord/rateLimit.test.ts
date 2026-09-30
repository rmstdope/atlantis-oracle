import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/discord/rateLimit.js';

describe('RateLimiter', () => {
  it('allows `limit` hits per window per user', () => {
    let now = 0;
    const rl = new RateLimiter(2, 60_000, () => now);
    expect(rl.check('a').allowed).toBe(true);
    now = 10_000;
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(true);
    now = 20_000;
    expect(rl.check('a')).toEqual({ allowed: false, retryAfterMs: 40_000 });
    now = 60_000;
    expect(rl.check('a').allowed).toBe(true);
  });
});
