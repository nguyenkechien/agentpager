import { describe, expect, it } from 'vitest';
import { appendLogLines, MAX_LOG_LINES, matchesLogFilter } from '../../src/renderer/logBuffer.js';
import type { LogLine } from '../../src/shared/api.js';

const line = (message: string, level: LogLine['level'] = 'info', extra: LogLine['extra'] = null): LogLine => ({ time: 1, level, message, extra });

describe('appendLogLines', () => {
  it('numbers new lines and keeps only the newest', () => {
    const first = appendLogLines([], [line('a'), line('b')], 0, 3);
    expect(first.map((entry) => [entry.id, entry.message])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
    const second = appendLogLines(first, [line('c'), line('d')], 2, 3);
    expect(second.map((entry) => [entry.id, entry.message])).toEqual([
      [1, 'b'],
      [2, 'c'],
      [3, 'd'],
    ]);
    expect(MAX_LOG_LINES).toBe(2_000);
  });
});

describe('matchesLogFilter', () => {
  it('filters by minimum level but keeps lines without a level', () => {
    const lines = [line('t', 'trace'), line('i'), line('w', 'warn'), line('e', 'error'), line('f', 'fatal'), line('plain', null)];
    const shown = (filter: 'all' | 'info' | 'warn' | 'error') => lines.filter((entry) => matchesLogFilter(entry, filter, '')).map((entry) => entry.message);
    expect(shown('all')).toEqual(['t', 'i', 'w', 'e', 'f', 'plain']);
    expect(shown('info')).toEqual(['i', 'w', 'e', 'f', 'plain']);
    expect(shown('warn')).toEqual(['w', 'e', 'f', 'plain']);
    expect(shown('error')).toEqual(['e', 'f', 'plain']);
  });

  it('searches the message and the extra fields, ignoring case', () => {
    const guard = line('guard blocked a command', 'warn', { rule: 'Kill-Bot' });
    expect(matchesLogFilter(guard, 'all', 'GUARD')).toBe(true);
    expect(matchesLogFilter(guard, 'all', 'kill-bot')).toBe(true);
    expect(matchesLogFilter(guard, 'all', 'telegram')).toBe(false);
    expect(matchesLogFilter(guard, 'all', '   ')).toBe(true);
  });
});
