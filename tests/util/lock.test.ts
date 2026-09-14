import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, isPidAlive, LockHeldError } from '../../src/util/lock.js';

let file: string;

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'pager-lock-')), 'bot.lock');
});

describe('lock', () => {
  it('detects live and dead pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(deadPid())).toBe(false);
  });

  it('writes the pid when acquiring a free lock', async () => {
    await acquireLock(file, 1234);
    expect(readFileSync(file, 'utf8')).toBe('1234');
  });

  it('refuses when a live process holds the lock', async () => {
    await acquireLock(file, process.pid);
    const attempt = acquireLock(file, 999_999);
    await expect(attempt).rejects.toBeInstanceOf(LockHeldError);
    await expect(attempt).rejects.toMatchObject({ pid: process.pid });
  });

  it('takes over a lock left by a dead process', async () => {
    writeFileSync(file, String(deadPid()));
    await acquireLock(file, 4321);
    expect(readFileSync(file, 'utf8')).toBe('4321');
  });

  it('takes over a lock with garbage content', async () => {
    writeFileSync(file, 'garbage');
    await acquireLock(file, 4321);
    expect(readFileSync(file, 'utf8')).toBe('4321');
  });

  it('removes the file on release', async () => {
    const lock = await acquireLock(file, 1234);
    await lock.release();
    expect(existsSync(file)).toBe(false);
  });
});
