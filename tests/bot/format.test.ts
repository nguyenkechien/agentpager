import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, historyLine, relativeTime, statusText, usageText } from '../../src/bot/format.js';
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

describe('formatDuration beyond a day', () => {
  it.each([
    [7 * 24 * HOUR, '7 ngày'],
    [3 * 24 * HOUR + 9 * HOUR + 20 * MINUTE, '3 ngày 9 giờ'],
    [24 * HOUR, '1 ngày'],
  ])('%d → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatClock', () => {
  const now = new Date(2026, 8, 14, 12, 0).getTime();

  it('shows only the time for today', () => {
    expect(formatClock(new Date(2026, 8, 14, 14, 20).getTime(), now)).toBe('14:20');
  });

  it('adds the date for other days', () => {
    expect(formatClock(new Date(2026, 8, 21, 9, 5).getTime(), now)).toBe('09:05 21/09');
  });
});

describe('usageText', () => {
  const now = new Date(2026, 8, 14, 12, 0).getTime();

  it('renders bars, percentages and reset times', () => {
    expect(
      usageText(
        {
          subscription: 'max',
          available: true,
          extraUsageEnabled: false,
          windows: [
            { key: 'five_hour', label: '5 giờ', utilizationPercent: 39, resetsAtMs: now + 2 * HOUR + 40 * MINUTE },
            { key: 'seven_day', label: '7 ngày', utilizationPercent: 46, resetsAtMs: new Date(2026, 8, 17, 21, 0).getTime() },
            { key: 'model:Fable', label: '7 ngày · Fable', utilizationPercent: 3, resetsAtMs: null },
            { key: 'seven_day_sonnet', label: '7 ngày · Sonnet', utilizationPercent: null, resetsAtMs: null },
          ],
        },
        now,
      ),
    ).toBe(
      [
        '📊 Usage · gói max',
        '5 giờ: ▓▓▓▓░░░░░░ 39% · reset 14:40 (còn 2 giờ 40 phút)',
        '7 ngày: ▓▓▓▓▓░░░░░ 46% · reset 21:00 17/09 (còn 3 ngày 9 giờ)',
        '7 ngày · Fable: ░░░░░░░░░░ 3%',
        '7 ngày · Sonnet: ░░░░░░░░░░ ?%',
        '💳 Extra usage: tắt',
      ].join('\n'),
    );
  });

  it('explains accounts without plan limits', () => {
    expect(usageText({ subscription: null, available: false, extraUsageEnabled: false, windows: [] }, now)).toBe(
      '📊 Tài khoản này không có limit theo gói (API key hoặc cloud provider).',
    );
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
    limitBlock: null,
  };

  it('shows an active plan limit block', () => {
    const now = new Date(2026, 8, 14, 12, 0).getTime();
    const blocked: StatusSnapshot = {
      ...idle,
      idleRemainingMs: null,
      lastTurnCostUsd: null,
      limitBlock: { label: '5 giờ', resetsAtMs: new Date(2026, 8, 14, 14, 0).getTime() },
    };
    expect(statusText(blocked, now).split('\n')).toContain('⛔ Hết limit 5 giờ · reset lúc 14:00 (còn 2 giờ)');
  });

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
