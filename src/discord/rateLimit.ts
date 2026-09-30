export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Sliding-window limit per user, in memory. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(userId: string): RateLimitResult {
    const now = this.now();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(userId, recent);
      return { allowed: false, retryAfterMs: this.windowMs - (now - recent[0]!) };
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return { allowed: true };
  }
}
