import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: ['token', 'apiKey', '*.token', '*.apiKey'],
    transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
  });
}
