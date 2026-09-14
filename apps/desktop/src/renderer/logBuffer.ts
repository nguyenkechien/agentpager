import type { LogLine } from '../shared/api.js';

export const MAX_LOG_LINES = 2_000;

export type LevelFilter = 'all' | 'info' | 'warn' | 'error';

export interface LogEntry extends LogLine {
  id: number;
}

const RANK: Record<NonNullable<LogLine['level']>, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const MIN_RANK: Record<LevelFilter, number> = { all: 0, info: 30, warn: 40, error: 50 };

/** Appends a batch with ids starting at `firstId`, keeping only the newest `max` lines. */
export function appendLogLines(current: readonly LogEntry[], lines: readonly LogLine[], firstId: number, max = MAX_LOG_LINES): LogEntry[] {
  const added = lines.map((line, index) => ({ ...line, id: firstId + index }));
  return [...current, ...added].slice(-max);
}

export function matchesLogFilter(line: LogLine, filter: LevelFilter, search: string): boolean {
  // Lines without a level (crash traces, read warnings) stay visible under every level filter.
  if (line.level !== null && RANK[line.level] < MIN_RANK[filter]) return false;
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return line.message.toLowerCase().includes(needle) || (line.extra !== null && JSON.stringify(line.extra).toLowerCase().includes(needle));
}
