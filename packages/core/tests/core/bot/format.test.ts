import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, historyLine, relativeTime, statusText, usageText } from '../../../src/core/bot/format.js';
import type { StatusSnapshot } from '../../../src/core/sessions/manager.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 100 * 24 * HOUR;

describe('relativeTime', () => {
  it.each([
    [NOW - 5_000, 'just now'],
    [NOW - 59_999, 'just now'],
    [NOW - MINUTE, '1 minute ago'],
    [NOW - 59 * MINUTE, '59 minutes ago'],
    [NOW - HOUR, '1 hour ago'],
    [NOW - 23 * HOUR, '23 hours ago'],
    [NOW - 24 * HOUR, '1 day ago'],
    [NOW - 40 * 24 * HOUR, '40 days ago'],
    [NOW + 5_000, 'just now'],
  ])('%d → %s', (then, expected) => {
    expect(relativeTime(then, NOW)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 seconds'],
    [42_000, '42 seconds'],
    [5 * MINUTE + 3_000, '5 minutes'],
    [HOUR, '1 hour'],
    [HOUR + 5 * MINUTE, '1 hour 5 minutes'],
  ])('%d → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatDuration beyond a day', () => {
  it.each([
    [7 * 24 * HOUR, '7 days'],
    [3 * 24 * HOUR + 9 * HOUR + 20 * MINUTE, '3 days 9 hours'],
    [24 * HOUR, '1 day'],
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
            { key: 'five_hour', label: '5-hour', scope: 'global', utilizationPercent: 39, resetsAtMs: now + 2 * HOUR + 40 * MINUTE },
            { key: 'seven_day', label: '7-day', scope: 'global', utilizationPercent: 46, resetsAtMs: new Date(2026, 8, 17, 21, 0).getTime() },
            { key: 'model:Fable', label: '7-day · Fable', scope: 'model', utilizationPercent: 3, resetsAtMs: null },
            { key: 'seven_day_sonnet', label: '7-day · Sonnet', scope: 'model', utilizationPercent: null, resetsAtMs: null },
          ],
        },
        now,
      ),
    ).toBe(
      [
        '📊 Usage · max plan',
        '5-hour: ▓▓▓▓░░░░░░ 39% · resets 14:40 (in 2 hours 40 minutes)',
        '7-day: ▓▓▓▓▓░░░░░ 46% · resets 21:00 17/09 (in 3 days 9 hours)',
        '7-day · Fable: ░░░░░░░░░░ 3%',
        '7-day · Sonnet: ░░░░░░░░░░ ?%',
        '💳 Extra usage: off',
      ].join('\n'),
    );
  });

  it('explains accounts without plan limits', () => {
    expect(usageText({ subscription: null, available: false, extraUsageEnabled: false, windows: [] }, now)).toBe(
      '📊 This account has no plan limits (API key or cloud provider).',
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
    expect(historyLine(entry, NOW, 'bot')).toBe('Fix login · trader · 3 hours ago');
  });

  it('marks bot-owned and possibly open sessions in all mode', () => {
    expect(historyLine(entry, NOW, 'all')).toBe('🤖 Fix login · trader · 3 hours ago');
    expect(historyLine({ ...entry, botOwned: false, maybeOpenElsewhere: true }, NOW, 'all')).toBe(
      '⚠️ Fix login · trader · 3 hours ago (may be open elsewhere)',
    );
  });

  it('handles an unknown project', () => {
    expect(historyLine({ ...entry, cwd: null }, NOW, 'bot')).toBe('Fix login · ? · 3 hours ago');
  });
});

describe('statusText', () => {
  const idle: StatusSnapshot = {
    agent: 'Claude Code',
    guardSupported: true,
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
      limitBlock: { label: '5-hour', resetsAtMs: new Date(2026, 8, 14, 14, 0).getTime() },
    };
    expect(statusText(blocked, now).split('\n')).toContain('⛔ Reached the 5-hour limit · resets at 14:00 (in 2 hours)');
  });

  it('notes a provider without a command guard', () => {
    expect(statusText({ ...idle, guardSupported: false }, NOW).split(String.fromCharCode(10)).at(-1)).toBe('🛡 Guard: not supported by the provider');
  });

  it('describes an idle session', () => {
    expect(statusText(idle, NOW)).toBe(
      [
        '🧠 Agent: Claude Code',
        '📁 Project: D:\\Projects\\trader',
        '🧵 Session: 12345678',
        '⚙️ State: idle',
        '📥 Queue: 0',
        '💤 Session ends in: 50 minutes',
        '🤖 Model: default · Effort: max',
        '💰 Last turn: ~$0.1234 (estimated)',
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
        '🧠 Agent: Claude Code',
        '📁 Project: D:\\Projects\\trader',
        '🧵 Session: none',
        '⚙️ State: running for 5 minutes · tool: Bash · ⏳ waiting for your reply',
        '📥 Queue: 2',
        '🤖 Model: opus · Effort: max',
      ].join('\n'),
    );
  });
});
