import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, startSchedule } from '../../../src/main/update/schedule.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startSchedule', () => {
  it('checks after the first delay, then on every interval, until stopped', async () => {
    vi.useFakeTimers();
    let checks = 0;
    const stop = startSchedule(
      () => {
        checks += 1;
        return Promise.resolve();
      },
      () => undefined,
    );
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS - 1);
    expect(checks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(checks).toBe(1);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    expect(checks).toBe(3);
    stop();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    expect(checks).toBe(3);
    await Promise.resolve();
  });

  it('passes failed checks to the error handler', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const stop = startSchedule(
      () => Promise.reject(new Error('boom')),
      (error) => {
        errors.push(error);
      },
      0,
    );
    vi.advanceTimersByTime(0);
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    stop();
  });

  it('never checks when stopped before the first delay', () => {
    vi.useFakeTimers();
    let checks = 0;
    const stop = startSchedule(
      () => {
        checks += 1;
        return Promise.resolve();
      },
      () => undefined,
    );
    stop();
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS * 2);
    expect(checks).toBe(0);
  });
});
