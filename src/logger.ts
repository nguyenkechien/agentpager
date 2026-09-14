import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, logDir: string): Logger {
  const transport = pino.transport({
    targets: [
      { target: 'pino/file', level, options: { destination: 1 } },
      {
        target: 'pino-roll',
        level,
        options: {
          file: join(logDir, 'claude-pager'),
          extension: '.log',
          frequency: 'daily',
          limit: { count: 14 },
          mkdir: true,
        },
      },
    ],
  });
  return pino({ level }, transport);
}
