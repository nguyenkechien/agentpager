import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { FATAL_WORKER_LOG } from '../daemon/supervisor.js';
import { pathExists } from '../util/fs.js';

const LEVEL_NAMES: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const HIDDEN_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname']);
/** pino-roll names worker logs `agentpager.<n>.log`. */
const WORKER_LOG_PATTERN = /^agentpager\..+\.log$/;
export const SUPERVISOR_LOG = 'supervisor.log';
export const DEFAULT_FOLLOW_INTERVAL_MS = 500;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `HH:mm:ss LEVEL message {other keys}`; lines that are not pino JSON are returned unchanged. */
export function formatLogLine(line: string): string {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // Plain text (e.g. a crash trace) is still worth showing as-is.
    return line;
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return line;
  const record = entry as Record<string, unknown>;
  const time = typeof record.time === 'number' ? new Date(record.time) : null;
  const clock = time ? `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}` : '--:--:--';
  const level = typeof record.level === 'number' ? (LEVEL_NAMES[record.level] ?? String(record.level)) : '?';
  const message = typeof record.msg === 'string' ? record.msg : '';
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !HIDDEN_KEYS.has(key)));
  const extraText = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  return `${clock} ${level.padEnd(5)} ${message}${extraText}`;
}

export async function newestLogFile(logDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(logDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const files = await Promise.all(
    names
      .filter((name) => WORKER_LOG_PATTERN.test(name))
      .map(async (name) => {
        const path = join(logDir, name);
        return { path, mtimeMs: (await stat(path)).mtimeMs };
      }),
  );
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.path ?? null;
}

/** The last non-empty lines of one log file; no file (yet) means no lines. */
export async function readLogFileTail(file: string | null, lines: number): Promise<string[]> {
  if (file === null) return [];
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-lines);
}

export async function readLogTail(logDir: string, lines: number): Promise<string[]> {
  return readLogFileTail(await newestLogFile(logDir), lines);
}

/** `supervisor.log` once the daemon has created it. */
export async function supervisorLogFile(logDir: string): Promise<string | null> {
  const file = join(logDir, SUPERVISOR_LOG);
  return (await pathExists(file)) ? file : null;
}

const fatalRecordSchema = z.object({ time: z.number(), msg: z.literal(FATAL_WORKER_LOG), message: z.string() });

export async function lastDaemonFatal(logDir: string, sinceMs: number): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(logDir, SUPERVISOR_LOG), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(FATAL_WORKER_LOG)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // The supervisor may still be writing its last line.
      continue;
    }
    const parsed = fatalRecordSchema.safeParse(record);
    if (parsed.success && parsed.data.time >= sinceMs) found = parsed.data.message;
  }
  return found;
}

/** Polls the newest worker log and reports appended lines, switching files when the log rotates. */
export function followLog(logDir: string, onLine: (line: string) => void, intervalMs = DEFAULT_FOLLOW_INTERVAL_MS): Promise<() => void> {
  return followLogFile(() => newestLogFile(logDir), onLine, intervalMs);
}

/**
 * Polls the file `resolveFile` names and reports appended lines. A different name starts over from its beginning
 * (rotation, or a file that did not exist yet); a shrunken file (truncated) is read again from the start.
 */
export async function followLogFile(
  resolveFile: () => Promise<string | null>,
  onLine: (line: string) => void,
  intervalMs = DEFAULT_FOLLOW_INTERVAL_MS,
): Promise<() => void> {
  let file = await resolveFile();
  let offset = file ? (await stat(file)).size : 0;
  let partial = '';
  let busy = false;

  const poll = async (): Promise<void> => {
    const newest = await resolveFile();
    if (newest && newest !== file) {
      file = newest;
      offset = 0;
      partial = '';
    }
    if (!file) return;
    const size = (await stat(file)).size;
    if (size < offset) {
      offset = 0;
      partial = '';
    }
    if (size === offset) return;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (partial + buffer.toString('utf8')).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') onLine(line);
    } finally {
      await handle.close();
    }
  };

  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    poll()
      .catch((error: unknown) => {
        onLine(`⚠️ Không đọc được log: ${messageOf(error)}`);
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
