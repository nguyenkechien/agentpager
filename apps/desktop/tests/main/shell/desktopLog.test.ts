import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDesktopLog, DESKTOP_LOG } from '../../../src/main/shell/desktopLog.js';

describe('createDesktopLog', () => {
  it('appends pino-style JSON lines, creating the log folder', () => {
    const logs = join(mkdtempSync(join(tmpdir(), 'ap-desktop-log-')), 'logs');
    const log = createDesktopLog(logs, () => 1_757_836_800_000);
    log.info('window shown', { hidden: false });
    log.error('uncaught exception', new TypeError('boom'));
    log.error('unhandled rejection', 'plain reason');

    const lines = readFileSync(join(logs, DESKTOP_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({ level: 30, time: 1_757_836_800_000, component: 'desktop', msg: 'window shown', hidden: false });
    expect(lines[1]).toMatchObject({ level: 50, msg: 'uncaught exception', err: { type: 'TypeError', message: 'boom' } });
    expect((lines[1]?.err as { stack: string }).stack).toContain('TypeError: boom');
    expect(lines[2]).toMatchObject({ level: 50, msg: 'unhandled rejection', err: { type: 'string', message: 'plain reason', stack: null } });
  });
});
