import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusPoller } from '../../../src/main/live/statusPoller.js';
import type { DaemonView } from '../../../src/shared/api.js';

function view(overrides: Partial<DaemonView> = {}): DaemonView {
  return {
    badge: 'stopped',
    pid: null,
    startedAt: null,
    workerPid: null,
    restarts: 0,
    botUsername: null,
    provider: null,
    lastError: null,
    launcher: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StatusPoller', () => {
  it('pushes the first view and then only changes', async () => {
    const views = [view(), view(), view({ badge: 'running', pid: 42 }), view({ badge: 'running', pid: 42 })];
    const changes: DaemonView[] = [];
    const poller = new StatusPoller({
      read: () => Promise.resolve(views.shift() ?? view({ badge: 'running', pid: 42 })),
      onChange: (next) => changes.push(next),
      onError: (error) => {
        throw error;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([view()]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(changes).toEqual([view(), view({ badge: 'running', pid: 42 })]);
    expect(poller.current()).toEqual(view({ badge: 'running', pid: 42 }));
    poller.stop();
  });

  it('never overlaps reads while one is slow', async () => {
    let reads = 0;
    let release: (value: DaemonView) => void = () => undefined;
    const poller = new StatusPoller({
      read: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      onChange: () => undefined,
      onError: () => undefined,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(1);
    const shared = poller.refresh();
    expect(reads).toBe(1);
    release(view());
    await expect(shared).resolves.toEqual(view());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(2);
    poller.stop();
  });

  it('reports read errors and keeps polling; stop ends the timer', async () => {
    const errors: unknown[] = [];
    let reads = 0;
    const poller = new StatusPoller({
      read: () => {
        reads += 1;
        return reads === 1 ? Promise.reject(new Error('EPERM')) : Promise.resolve(view());
      },
      onChange: () => undefined,
      onError: (error) => errors.push(error),
    });
    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(errors).toEqual([new Error('EPERM')]);
    expect(reads).toBe(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(2);
  });
});
