import { describe, expect, it } from 'vitest';
import { parseLogLine } from '../../../src/main/live/logLine.js';

describe('parseLogLine', () => {
  it('splits a pino line into time, level, message and extra fields', () => {
    expect(
      parseLogLine(
        JSON.stringify({ level: 40, time: 1_757_836_800_000, pid: 12, hostname: 'pc', msg: 'guard blocked a command', chatId: 7, rule: 'rm-root' }),
      ),
    ).toEqual({ time: 1_757_836_800_000, level: 'warn', message: 'guard blocked a command', extra: { chatId: 7, rule: 'rm-root' } });
    expect(parseLogLine('{"level":30,"time":1,"msg":"ok"}')).toEqual({ time: 1, level: 'info', message: 'ok', extra: null });
  });

  it('keeps unknown levels and non-JSON lines readable', () => {
    expect(parseLogLine('{"level":35,"msg":"custom"}')).toEqual({ time: null, level: null, message: 'custom', extra: null });
    expect(parseLogLine('Error: boom\n    at main.js:1')).toEqual({ time: null, level: null, message: 'Error: boom\n    at main.js:1', extra: null });
    expect(parseLogLine('[1,2]')).toEqual({ time: null, level: null, message: '[1,2]', extra: null });
  });
});
