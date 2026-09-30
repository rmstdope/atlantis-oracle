import { describe, expect, it } from 'vitest';
import { Limiter } from '../../src/llm/limiter.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('Limiter', () => {
  it('runs at most max tasks at once, in FIFO order', async () => {
    const limiter = new Limiter(1);
    const order: string[] = [];
    const first = deferred();

    const a = limiter.run(async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = limiter.run(async () => void order.push('b'));
    const c = limiter.run(async () => void order.push('c'));
    await Promise.resolve();
    expect(limiter.waiting).toBe(2);

    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a:start', 'a:end', 'b', 'c']);
    expect(limiter.waiting).toBe(0);
  });

  it('releases the slot when a task fails', async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(await limiter.run(async () => 42)).toBe(42);
  });
});
