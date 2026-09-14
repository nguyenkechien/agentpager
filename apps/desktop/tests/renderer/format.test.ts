import { describe, expect, it } from 'vitest';
import { formatClock, formatDateTime, formatDuration } from '../../src/renderer/format.js';

describe('formatDuration', () => {
  it('uses the largest useful units', () => {
    expect(formatDuration(-5)).toBe('0 giây');
    expect(formatDuration(45_900)).toBe('45 giây');
    expect(formatDuration(3 * 60_000 + 59_000)).toBe('3 phút');
    expect(formatDuration(2 * 3_600_000)).toBe('2 giờ');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 giờ 5 phút');
    expect(formatDuration(86_400_000)).toBe('1 ngày');
    expect(formatDuration(86_400_000 + 3 * 3_600_000 + 60_000)).toBe('1 ngày 3 giờ');
  });
});

describe('formatDateTime and formatClock', () => {
  it('formats local times and keeps unparseable text', () => {
    const local = new Date(2026, 8, 14, 16, 5, 9);
    expect(formatDateTime(local.toISOString())).toBe('14/09/2026 16:05');
    expect(formatDateTime('not a date')).toBe('not a date');
    expect(formatClock(local.getTime())).toBe('16:05:09');
  });
});
