import type { LogLine } from '../../shared/api.js';

const LEVELS: Record<number, NonNullable<LogLine['level']>> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const HIDDEN_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname']);

/** A pino JSON line as structured fields; anything else (a crash trace, a read warning) as a plain message. */
export function parseLogLine(raw: string): LogLine {
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    // Not JSON: still worth showing as written.
    return { time: null, level: null, message: raw, extra: null };
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { time: null, level: null, message: raw, extra: null };
  const record = entry as Record<string, unknown>;
  const extraEntries = Object.entries(record).filter(([key]) => !HIDDEN_KEYS.has(key));
  return {
    time: typeof record.time === 'number' ? record.time : null,
    level: typeof record.level === 'number' ? (LEVELS[record.level] ?? null) : null,
    message: typeof record.msg === 'string' ? record.msg : '',
    extra: extraEntries.length > 0 ? Object.fromEntries(extraEntries) : null,
  };
}
