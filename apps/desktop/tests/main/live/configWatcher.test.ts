import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchConfig } from '../../../src/main/live/configWatcher.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface WatchState {
  emit: (fileName: string | null) => void;
  closed: boolean;
  watchedDir: string;
  changes: number;
}

function harness() {
  const state: WatchState = { emit: () => undefined, closed: false, watchedDir: '', changes: 0 };
  const watcher = watchConfig({
    dir: 'C:\\agentpager',
    fileName: 'config.json',
    watch: (dir, listener) => {
      state.watchedDir = dir;
      state.emit = listener;
      return {
        close: () => {
          state.closed = true;
        },
      };
    },
    onChange: () => {
      state.changes += 1;
    },
  });
  return { state, watcher };
}

describe('watchConfig', () => {
  it('fires once per burst of config events, 300 ms after the last one', async () => {
    const { state, watcher } = harness();
    expect(state.watchedDir).toBe('C:\\agentpager');
    state.emit('config.json.123.ab.tmp');
    state.emit('config.json');
    await vi.advanceTimersByTimeAsync(200);
    state.emit('config.json');
    await vi.advanceTimersByTimeAsync(299);
    expect(state.changes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.changes).toBe(1);
    watcher.close();
  });

  it('ignores other files, counts unnamed events and stops on close', async () => {
    const { state, watcher } = harness();
    state.emit('state.json');
    state.emit('daemon.json');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.changes).toBe(0);
    state.emit(null);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.changes).toBe(1);

    state.emit('config.json');
    watcher.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.changes).toBe(1);
    expect(state.closed).toBe(true);
  });
});
