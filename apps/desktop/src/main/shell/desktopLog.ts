import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DESKTOP_LOG = 'desktop.log';

export interface DesktopLog {
  info: (message: string, fields?: Record<string, unknown>) => void;
  error: (context: string, error: unknown) => void;
}

function serializeError(error: unknown): { type: string; message: string; stack: string | null } {
  if (error instanceof Error) return { type: error.name, message: error.message, stack: error.stack ?? null };
  return { type: typeof error, message: String(error), stack: null };
}

/**
 * Main-process problems of the app itself, as pino-style JSON lines next to the bot logs. Synchronous: it is used
 * from crash handlers, right before the process may end.
 */
export function createDesktopLog(logsDir: string, now: () => number = Date.now): DesktopLog {
  const write = (level: number, msg: string, fields: Record<string, unknown>): void => {
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, DESKTOP_LOG), `${JSON.stringify({ level, time: now(), component: 'desktop', msg, ...fields })}\n`, 'utf8');
  };
  return {
    info: (message, fields = {}) => {
      write(30, message, fields);
    },
    error: (context, error) => {
      write(50, context, { err: serializeError(error) });
    },
  };
}
