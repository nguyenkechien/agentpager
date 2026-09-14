import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class LockHeldError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`Another claude-pager instance is running (pid ${pid})`);
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

async function readHolder(filePath: string): Promise<number | null> {
  const content = (await readFile(filePath, 'utf8')).trim();
  return /^\d+$/.test(content) ? Number(content) : null;
}

async function createExclusive(filePath: string, pid: number): Promise<boolean> {
  try {
    await writeFile(filePath, String(pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export async function acquireLock(filePath: string, pid: number = process.pid): Promise<{ release(): Promise<void> }> {
  await mkdir(dirname(filePath), { recursive: true });

  if (!(await createExclusive(filePath, pid))) {
    const holder = await readHolder(filePath);
    if (holder !== null && holder !== pid && isPidAlive(holder)) throw new LockHeldError(holder);

    // Stale lock: remove it and retry exactly once. If another process created it in between, it owns the lock.
    await rm(filePath, { force: true });
    if (!(await createExclusive(filePath, pid))) {
      const winner = await readHolder(filePath);
      throw new LockHeldError(winner ?? -1);
    }
  }

  return {
    async release(): Promise<void> {
      const holder = await readHolder(filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (holder === pid) await rm(filePath, { force: true });
    },
  };
}
