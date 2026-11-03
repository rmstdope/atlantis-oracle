import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heartbeatIsFresh, startHeartbeat } from '../src/heartbeat.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'oracle-heartbeat-'));
  file = path.join(dir, 'beat');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('heartbeat', () => {
  it('is missing until the bot is alive', async () => {
    const stop = await startHeartbeat(() => false, file, 60_000);
    expect(await heartbeatIsFresh(file)).toBe(false);
    await stop();
  });

  it('beats while alive and is removed on stop', async () => {
    const stop = await startHeartbeat(() => true, file, 60_000);
    await expect.poll(() => heartbeatIsFresh(file)).toBe(true);
    await stop();
    expect(await heartbeatIsFresh(file)).toBe(false);
  });

  it('removes a stale file from an earlier run', async () => {
    await writeFile(file, 'old\n');
    const stop = await startHeartbeat(() => false, file, 60_000);
    expect(await heartbeatIsFresh(file)).toBe(false);
    await stop();
  });

  it('goes stale after the maximum age', async () => {
    await writeFile(file, 'x\n');
    const then = new Date(Date.now() - 120_000);
    await utimes(file, then, then);
    expect(await heartbeatIsFresh(file)).toBe(false);
    expect(await heartbeatIsFresh(file, Date.now(), 180_000)).toBe(true);
  });
});
