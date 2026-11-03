import { stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Liveness without a port: while the bot is connected to Discord it touches a
 * file every few seconds, and `dist/health.js` (the container healthcheck)
 * checks that the file is recent. The file lives in the container's /tmp, so
 * it never outlives the container's filesystem or lands on the data volume.
 */
export const HEARTBEAT_FILE = path.join(tmpdir(), 'atlantis-oracle.heartbeat');
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** Older than this means unhealthy: a few missed beats, not one slow one. */
export const HEARTBEAT_MAX_AGE_MS = 90_000;

/**
 * Writes the heartbeat whenever `alive()` says so; returns a stop function
 * that also removes the file. A stale file from an earlier run is removed
 * first, so a restart is not healthy until it is connected again.
 */
export async function startHeartbeat(
  alive: () => boolean,
  file = HEARTBEAT_FILE,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): Promise<() => Promise<void>> {
  await unlink(file).catch(() => {});
  const beat = () => {
    if (alive()) void writeFile(file, `${new Date().toISOString()}\n`).catch(() => {});
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await unlink(file).catch(() => {});
  };
}

/** True when the heartbeat file exists and was written recently. */
export async function heartbeatIsFresh(
  file = HEARTBEAT_FILE,
  now = Date.now(),
  maxAgeMs = HEARTBEAT_MAX_AGE_MS,
): Promise<boolean> {
  try {
    return now - (await stat(file)).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}
