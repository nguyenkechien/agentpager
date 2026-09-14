import type { LogLine, LogSource } from '../../shared/api.js';
import { parseLogLine } from './logLine.js';

export const LOG_BATCH_MS = 250;
export const LOG_TAIL_LINES = 2_000;

export interface LogReaders {
  readTail: (source: LogSource, lines: number) => Promise<string[]>;
  /** Resolves with a function that stops following. */
  follow: (source: LogSource, onLine: (line: string) => void) => Promise<() => void>;
}

export interface LogStreamOptions {
  batchMs?: number;
  tailLines?: number;
}

/** One log view: the tail first, then appended lines in batches so a chatty log does not flood the renderer. */
export class LogStream {
  private buffer: LogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopFollowing: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly source: LogSource,
    private readonly readers: LogReaders,
    private readonly send: (lines: LogLine[]) => void,
    private readonly options: LogStreamOptions = {},
  ) {}

  async start(): Promise<void> {
    const tail = await this.readers.readTail(this.source, this.options.tailLines ?? LOG_TAIL_LINES);
    // stop() may run while either read is pending.
    if (this.isStopped()) return;
    if (tail.length > 0) this.send(tail.map(parseLogLine));
    const stop = await this.readers.follow(this.source, (line) => {
      this.push(parseLogLine(line));
    });
    if (this.isStopped()) stop();
    else this.stopFollowing = stop;
  }

  /** A method, so the check after each await is not narrowed away by the one before it. */
  private isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.stopFollowing?.();
    this.stopFollowing = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
  }

  private push(line: LogLine): void {
    if (this.stopped) return;
    this.buffer.push(line);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const lines = this.buffer;
      this.buffer = [];
      if (lines.length > 0) this.send(lines);
    }, this.options.batchMs ?? LOG_BATCH_MS);
  }
}

/** Log views per window; a closed or hidden window drops all of its views. */
export class LogSubscriptions {
  private readonly streams = new Map<string, { senderId: number; stream: LogStream }>();

  constructor(
    private readonly readers: LogReaders,
    private readonly onError: (error: unknown) => void,
    private readonly options: LogStreamOptions = {},
  ) {}

  subscribe(senderId: number, id: string, source: LogSource, send: (lines: LogLine[]) => void): void {
    const key = `${String(senderId)}:${id}`;
    this.streams.get(key)?.stream.stop();
    const stream = new LogStream(source, this.readers, send, this.options);
    this.streams.set(key, { senderId, stream });
    stream.start().catch((error: unknown) => {
      this.onError(error);
    });
  }

  unsubscribe(senderId: number, id: string): void {
    const key = `${String(senderId)}:${id}`;
    this.streams.get(key)?.stream.stop();
    this.streams.delete(key);
  }

  unsubscribeSender(senderId: number): void {
    for (const [key, entry] of this.streams) {
      if (entry.senderId !== senderId) continue;
      entry.stream.stop();
      this.streams.delete(key);
    }
  }

  size(): number {
    return this.streams.size;
  }
}
