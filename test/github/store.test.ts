import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnomalyStore } from '../../src/github/store.js';
import { anomaly } from '../helpers/anomaly.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'oracle-anomalies-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AnomalyStore', () => {
  it('starts empty without a file and round-trips', async () => {
    const file = path.join(dir, 'sub', 'anomalies.json');
    const store = await AnomalyStore.load(file);
    expect(store.anomalies).toEqual([]);
    store.add(anomaly(7));
    store.add(anomaly(7, { title: 'replaced' }));
    store.data.poll.etag = 'x';
    await store.save();
    const again = await AnomalyStore.load(file);
    expect(again.anomalies).toEqual([anomaly(7, { title: 'replaced' })]);
    expect(again.data.poll.etag).toBe('x');
    again.remove(7);
    expect(again.find(7)).toBeUndefined();
  });

  it('refuses an invalid file instead of overwriting it', async () => {
    const file = path.join(dir, 'anomalies.json');
    await writeFile(file, '{"version":1,"anomalies":"nope"}');
    await expect(AnomalyStore.load(file)).rejects.toThrow(/not a valid anomaly store/);
    expect(await readFile(file, 'utf8')).toContain('nope');
  });
});
