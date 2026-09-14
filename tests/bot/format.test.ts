import { describe, expect, it } from 'vitest';
import { formatDuration, historyLine, relativeTime, statusText } from '../../src/bot/format.js';
import type { StatusSnapshot } from '../../src/sessions/manager.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 100 * 24 * HOUR;

describe('relativeTime', () => {
  it.each([
    [NOW - 5_000, 'vừa xong'],
    [NOW - 59_999, 'vừa xong'],
    [NOW - MINUTE, '1 phút trước'],
    [NOW - 59 * MINUTE, '59 phút trước'],
    [NOW - HOUR, '1 giờ trước'],
    [NOW - 23 * HOUR, '23 giờ trước'],
    [NOW - 24 * HOUR, '1 ngày trước'],
    [NOW - 40 * 24 * HOUR, '40 ngày trước'],
    [NOW + 5_000, 'vừa xong'],
  ])('%d → %s', (then, expected) => {
    expect(relativeTime(then, NOW)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 giây'],
    [42_000, '42 giây'],
    [5 * MINUTE + 3_000, '5 phút'],
    [HOUR, '1 giờ'],
    [HOUR + 5 * MINUTE, '1 giờ 5 phút'],
  ])('%d → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('historyLine', () => {
  const entry = {
    sessionId: 's1',
    title: 'Fix login',
    cwd: 'D:\\Projects\\trader',
    lastActiveAt: NOW - 3 * HOUR,
    botOwned: true,
    maybeOpenElsewhere: false,
  };

  it('shows title, project and time', () => {
    expect(historyLine(entry, NOW, 'bot')).toBe('Fix login · trader · 3 giờ trước');
  });

  it('marks bot-owned and possibly open sessions in all mode', () => {
    expect(historyLine(entry, NOW, 'all')).toBe('🤖 Fix login · trader · 3 giờ trước');
    expect(historyLine({ ...entry, botOwned: false, maybeOpenElsewhere: true }, NOW, 'all')).toBe(
      '⚠️ Fix login · trader · 3 giờ trước (có thể đang mở ở nơi khác)',
    );
  });

  it('handles an unknown project', () => {
    expect(historyLine({ ...entry, cwd: null }, NOW, 'bot')).toBe('Fix login · ? · 3 giờ trước');
  });
});

describe('statusText', () => {
  const idle: StatusSnapshot = {
    cwd: 'D:\\Projects\\trader',
    sessionId: '12345678-aaaa-bbbb-cccc-000000000000',
    runningSinceMs: null,
    currentTool: null,
    waitingForUser: false,
    queueLength: 0,
    idleRemainingMs: 50 * MINUTE,
    model: null,
    effort: 'max',
    lastTurnCostUsd: 0.1234,
  };

  it('describes an idle session', () => {
    expect(statusText(idle, NOW)).toBe(
      [
        '📁 Project: D:\\Projects\\trader',
        '🧵 Session: 12345678',
        '⚙️ Trạng thái: rảnh',
        '📥 Hàng đợi: 0',
        '💤 Hết phiên sau: 50 phút',
        '🤖 Model: mặc định · Effort: max',
        '💰 Lượt cuối: ~$0.1234 (ước tính)',
      ].join('\n'),
    );
  });

  it('describes a running turn waiting for the user', () => {
    const running: StatusSnapshot = {
      ...idle,
      sessionId: null,
      runningSinceMs: NOW - 5 * MINUTE,
      currentTool: 'Bash',
      waitingForUser: true,
      queueLength: 2,
      idleRemainingMs: null,
      model: 'opus',
      lastTurnCostUsd: null,
    };
    expect(statusText(running, NOW)).toBe(
      [
        '📁 Project: D:\\Projects\\trader',
        '🧵 Session: chưa có',
        '⚙️ Trạng thái: đang chạy 5 phút · tool: Bash · ⏳ đang chờ bạn trả lời',
        '📥 Hàng đợi: 2',
        '🤖 Model: opus · Effort: max',
      ].join('\n'),
    );
  });
});
