import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/** Written by the running supervisor; the token keeps other local users from controlling the daemon. */
export interface DaemonInfo {
  pid: number;
  startedAt: string;
  ipc: { path: string };
  token: string;
}

const FILE_MODE = 0o600;
const TOKEN_BYTES = 32;

const daemonInfoSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  ipc: z.object({ path: z.string().min(1) }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** A missing or unreadable-as-daemon-info file means no daemon is known to be running. */
export async function readDaemonInfo(path: string): Promise<DaemonInfo | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // A torn or hand-edited file cannot point at a live daemon; callers treat it like a missing file.
    return null;
  }
  const parsed = daemonInfoSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function writeDaemonInfo(path: string, info: DaemonInfo, platform: NodeJS.Platform): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
    if (platform !== 'win32') await chmod(tmpPath, FILE_MODE);
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

export async function removeDaemonInfo(path: string): Promise<void> {
  await rm(path, { force: true });
}
