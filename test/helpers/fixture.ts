import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';

export const FIXTURE_REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/game-repo',
);

export const silentLogger = pino({ level: 'silent' });
