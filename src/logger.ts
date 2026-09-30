import { pino, type Logger } from 'pino';

export type { Logger };

/** Logs to stdout by default; the CLI passes 2 to keep stdout for the answer. */
export function createLogger(level: string, fd: 1 | 2 = 1): Logger {
  const stream = fd === 1 ? process.stdout : process.stderr;
  return pino({
    level,
    redact: ['token', 'apiKey', '*.token', '*.apiKey'],
    transport: stream.isTTY
      ? { target: 'pino-pretty', options: { destination: fd } }
      : fd === 2
        ? { target: 'pino/file', options: { destination: 2 } }
        : undefined,
  });
}
