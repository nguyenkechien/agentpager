import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  followLog,
  followLogFile,
  formatLogLine,
  lastDaemonFatal,
  newestLogFile,
  readLogFileTail,
  readLogTail,
  supervisorLogFile,
} from '../../src/control/logFiles.js';
import { FATAL_WORKER_LOG } from '../../src/daemon/supervisor.js';

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'ap-logs-')), 'logs');
  mkdirSync(dir);
});

describe('formatLogLine', () => {
  it('formats pino JSON as time, level, message and extra keys', () => {
    const time = new Date(2026, 8, 14, 9, 5, 7).getTime();
    expect(
      formatLogLine(JSON.stringify({ level: 40, time, pid: 1, hostname: 'pc', chatId: 7, rule: 'kill-bot', msg: 'guard blocked a command' })),
    ).toBe('09:05:07 WARN  guard blocked a command {"chatId":7,"rule":"kill-bot"}');
    expect(formatLogLine(JSON.stringify({ level: 30, time, msg: 'ready' }))).toBe('09:05:07 INFO  ready');
  });

  it('returns text that is not a pino record unchanged', () => {
    expect(formatLogLine('    at main (file.js:1:1)')).toBe('    at main (file.js:1:1)');
    expect(formatLogLine('[1,2]')).toBe('[1,2]');
  });
});

describe('worker log files', () => {
  it('picks the most recently written log and returns its last lines', async () => {
    await expect(newestLogFile(dir)).resolves.toBeNull();
    await expect(readLogTail(join(dir, 'missing'), 5)).resolves.toEqual([]);

    const older = join(dir, 'agentpager.1.log');
    const newer = join(dir, 'agentpager.2.log');
    writeFileSync(older, 'old\n');
    writeFileSync(newer, 'a\nb\n\nc\nd\n');
    writeFileSync(join(dir, 'supervisor.log'), 'not a worker log\n');
    utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));

    await expect(newestLogFile(dir)).resolves.toBe(newer);
    await expect(readLogTail(dir, 3)).resolves.toEqual(['b', 'c', 'd']);
  });

  it('follows appended lines until stopped', async () => {
    const file = join(dir, 'agentpager.1.log');
    writeFileSync(file, 'before\n');
    const seen: string[] = [];
    const stop = await followLog(dir, (line) => seen.push(line), 10);
    appendFileSync(file, 'first\nsecond');
    await vi.waitFor(() => {
      expect(seen).toEqual(['first']);
    });
    appendFileSync(file, ' half\n');
    await vi.waitFor(() => {
      expect(seen).toEqual(['first', 'second half']);
    });
    stop();
  });
});

describe('supervisor log', () => {
  it('has no lines before the daemon creates it', async () => {
    await expect(supervisorLogFile(dir)).resolves.toBeNull();
    await expect(readLogFileTail(null, 5)).resolves.toEqual([]);
    await expect(readLogFileTail(join(dir, 'gone.log'), 5)).resolves.toEqual([]);
  });

  it('follows supervisor.log from its first line once it appears, and after truncation', async () => {
    const seen: string[] = [];
    const stop = await followLogFile(() => supervisorLogFile(dir), (line) => seen.push(line), 10);
    const file = join(dir, 'supervisor.log');
    writeFileSync(file, 'started\n');
    await vi.waitFor(() => {
      expect(seen).toEqual(['started']);
    });
    await expect(supervisorLogFile(dir)).resolves.toBe(file);
    await expect(readLogFileTail(file, 1)).resolves.toEqual(['started']);

    writeFileSync(file, 'new\n');
    await vi.waitFor(() => {
      expect(seen).toEqual(['started', 'new']);
    });
    stop();
  });
});

describe('lastDaemonFatal', () => {
  it('returns the latest fatal worker error logged since the given time', async () => {
    await expect(lastDaemonFatal(dir, 0)).resolves.toBeNull();
    const line = (time: number, message: string): string =>
      JSON.stringify({ level: 50, time, component: 'supervisor', message, msg: FATAL_WORKER_LOG });
    writeFileSync(
      join(dir, 'supervisor.log'),
      [line(100, 'old problem'), JSON.stringify({ level: 30, time: 300, msg: 'worker started' }), line(400, 'Invalid Telegram token'), '{"torn'].join('\n'),
    );
    await expect(lastDaemonFatal(dir, 200)).resolves.toBe('Invalid Telegram token');
    await expect(lastDaemonFatal(dir, 500)).resolves.toBeNull();
  });
});
