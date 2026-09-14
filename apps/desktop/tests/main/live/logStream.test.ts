import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogStream, LogSubscriptions, type LogReaders } from '../../../src/main/live/logStream.js';
import type { LogLine, LogSource } from '../../../src/shared/api.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const pino = (msg: string): string => JSON.stringify({ level: 30, time: 1, msg });
const line = (message: string): LogLine => ({ time: 1, level: 'info', message, extra: null });

interface FakeReaders {
  readers: LogReaders;
  tails: Map<LogSource, string[]>;
  tailRequests: { source: LogSource; lines: number }[];
  emit: Map<LogSource, (line: string) => void>;
  stopped: LogSource[];
}

function fakeReaders(): FakeReaders {
  const fake: FakeReaders = {
    tails: new Map(),
    tailRequests: [],
    emit: new Map(),
    stopped: [],
    readers: {
      readTail: (source, lines) => {
        fake.tailRequests.push({ source, lines });
        return Promise.resolve(fake.tails.get(source) ?? []);
      },
      follow: (source, onLine) => {
        fake.emit.set(source, onLine);
        return Promise.resolve(() => {
          fake.stopped.push(source);
        });
      },
    },
  };
  return fake;
}

function emitter(fake: FakeReaders, source: LogSource): (text: string) => void {
  const emit = fake.emit.get(source);
  if (!emit) throw new Error(`${source} is not followed`);
  return emit;
}

describe('LogStream', () => {
  it('sends the last 2,000 lines first, then batches appended lines every 250 ms', async () => {
    const fake = fakeReaders();
    fake.tails.set('worker', [pino('one'), pino('two')]);
    const sent: LogLine[][] = [];
    const stream = new LogStream('worker', fake.readers, (lines) => sent.push(lines));
    await stream.start();
    expect(fake.tailRequests).toEqual([{ source: 'worker', lines: 2_000 }]);
    expect(sent).toEqual([[line('one'), line('two')]]);

    emitter(fake, 'worker')(pino('three'));
    emitter(fake, 'worker')(pino('four'));
    await vi.advanceTimersByTimeAsync(249);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([[line('one'), line('two')], [line('three'), line('four')]]);
    stream.stop();
  });

  it('sends nothing for an empty log and stops following on stop, dropping the pending batch', async () => {
    const fake = fakeReaders();
    const sent: LogLine[][] = [];
    const stream = new LogStream('supervisor', fake.readers, (lines) => sent.push(lines));
    await stream.start();
    expect(sent).toEqual([]);
    emitter(fake, 'supervisor')(pino('late'));
    stream.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([]);
    expect(fake.stopped).toEqual(['supervisor']);
  });

  it('stops a follow that finishes starting after stop()', async () => {
    const fake = fakeReaders();
    let resolveTail: (lines: string[]) => void = () => undefined;
    fake.readers.readTail = () =>
      new Promise((resolve) => {
        resolveTail = resolve;
      });
    const stream = new LogStream('worker', fake.readers, () => undefined);
    const started = stream.start();
    stream.stop();
    resolveTail([pino('x')]);
    await started;
    expect(fake.emit.has('worker')).toBe(false);

    const second = fakeReaders();
    let resolveFollow: (stop: () => void) => void = () => undefined;
    second.readers.follow = () =>
      new Promise((resolve) => {
        resolveFollow = resolve;
      });
    const stopped: string[] = [];
    const late = new LogStream('worker', second.readers, () => undefined);
    const lateStart = late.start();
    await vi.advanceTimersByTimeAsync(0);
    late.stop();
    resolveFollow(() => stopped.push('worker'));
    await lateStart;
    expect(stopped).toEqual(['worker']);
  });
});

describe('LogSubscriptions', () => {
  it('keeps views per window and drops all of a window’s views at once', async () => {
    const fake = fakeReaders();
    const errors: unknown[] = [];
    const subscriptions = new LogSubscriptions(fake.readers, (error) => errors.push(error));
    subscriptions.subscribe(1, 'logs-1', 'worker', () => undefined);
    subscriptions.subscribe(1, 'logs-2', 'supervisor', () => undefined);
    subscriptions.subscribe(2, 'logs-1', 'worker', () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(subscriptions.size()).toBe(3);

    subscriptions.unsubscribe(2, 'logs-1');
    expect(subscriptions.size()).toBe(2);
    subscriptions.unsubscribeSender(1);
    expect(subscriptions.size()).toBe(0);
    expect(fake.stopped.sort()).toEqual(['supervisor', 'worker', 'worker']);
    expect(errors).toEqual([]);
  });

  it('replaces a view that subscribes again with the same id and reports start failures', async () => {
    const fake = fakeReaders();
    const errors: unknown[] = [];
    const subscriptions = new LogSubscriptions(fake.readers, (error) => errors.push(error));
    subscriptions.subscribe(1, 'logs-1', 'worker', () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    subscriptions.subscribe(1, 'logs-1', 'supervisor', () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.stopped).toEqual(['worker']);
    expect(subscriptions.size()).toBe(1);

    fake.readers.readTail = () => Promise.reject(new Error('EACCES'));
    subscriptions.subscribe(3, 'logs-9', 'worker', () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([new Error('EACCES')]);
  });
});
