import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitTracker } from '../../../src/core/sessions/limits.js';
import { StateStore } from '../../../src/core/sessions/store.js';
import type { LimitSnapshot, UsageReport } from '../../../src/providers/types.js';

const CHAT = 7;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const logger = pino({ level: 'silent' });

let clock: number;
let store: StateStore;
let notices: string[];
let usageResult: UsageReport | Error;
let fetchCount: number;
let tracker: LimitTracker;

function fetchUsage(): Promise<UsageReport> {
  fetchCount += 1;
  return usageResult instanceof Error ? Promise.reject(usageResult) : Promise.resolve(usageResult);
}

function createTracker(withUsage = true): LimitTracker {
  return new LimitTracker({
    store,
    notifier: {
      sendNotice: (_chatId, text) => {
        notices.push(text);
        return Promise.resolve();
      },
    },
    fetchUsage: withUsage ? fetchUsage : null,
    now: () => clock,
    logger,
  });
}

async function advance(ms: number): Promise<void> {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

function snapshot(overrides: Partial<LimitSnapshot>): LimitSnapshot {
  return {
    status: 'allowed',
    windowKey: 'five_hour',
    windowLabel: '5 giờ',
    scope: 'global',
    resetsAtMs: null,
    utilizationPercent: null,
    threshold: null,
    ...overrides,
  };
}

function report(windows: UsageReport['windows']): UsageReport {
  return { subscription: 'max', available: true, extraUsageEnabled: false, windows };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  clock = new Date(2026, 8, 14, 12, 0).getTime();
  const file = join(mkdtempSync(join(tmpdir(), 'pager-limits-')), 'state.json');
  store = (await StateStore.open(file, { cwd: 'D:\\Projects', model: null, effort: null }, () => clock)).store;
  notices = [];
  fetchCount = 0;
  usageResult = report([]);
  tracker = createTracker();
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
});

describe('warnings', () => {
  it('warns once per threshold and remembers it across restarts', async () => {
    const warn = snapshot({
      status: 'allowed_warning',
      resetsAtMs: clock + 2 * HOUR + 20 * MINUTE,
      utilizationPercent: 85,
      threshold: 0.8,
    });
    await tracker.onRateLimit(CHAT, warn);
    await tracker.onRateLimit(CHAT, warn);
    expect(notices).toEqual(['⚠️ Sắp chạm limit 5 giờ: đã dùng 85% · reset lúc 14:20 (còn 2 giờ 20 phút)']);

    await tracker.onRateLimit(CHAT, { ...warn, utilizationPercent: 95, threshold: 0.9 });
    expect(notices).toHaveLength(2);

    const restarted = createTracker();
    await restarted.onRateLimit(CHAT, warn);
    expect(notices).toHaveLength(2);
    restarted.dispose();
  });

  it('omits unknown parts of a warning', async () => {
    await tracker.onRateLimit(CHAT, snapshot({ status: 'allowed_warning', windowKey: 'seven_day', windowLabel: '7 ngày' }));
    expect(notices).toEqual(['⚠️ Sắp chạm limit 7 ngày']);
  });
});

describe('rejections', () => {
  it('blocks, notifies once and announces the reset', async () => {
    const reject = snapshot({ status: 'rejected', resetsAtMs: clock + HOUR, utilizationPercent: 100 });
    await tracker.onRateLimit(CHAT, reject);
    await tracker.onRateLimit(CHAT, reject);
    expect(notices).toEqual([
      '⛔ Đã hết limit 5 giờ · reset lúc 13:00 (còn 1 giờ). Session vẫn giữ — nhắn lại sau khi reset.',
    ]);
    expect(tracker.activeBlock(CHAT)).toEqual({ limitType: 'five_hour', label: '5 giờ', resetsAtMs: clock + HOUR });
    expect(store.getChat(CHAT).limitBlock).toEqual({ limitType: 'five_hour', label: '5 giờ', resetsAtMs: clock + HOUR });

    await advance(HOUR + 5_000);
    expect(notices.at(-1)).toBe('✅ Limit 5 giờ đã reset — dùng tiếp được.');
    expect(tracker.activeBlock(CHAT)).toBeNull();
    expect(store.getChat(CHAT).limitBlock).toBeNull();
  });

  it('does not block for model-scoped limits', async () => {
    await tracker.onRateLimit(
      CHAT,
      snapshot({
        status: 'rejected',
        windowKey: 'seven_day_opus',
        windowLabel: '7 ngày · Opus',
        scope: 'model',
        resetsAtMs: clock + 7 * DAY,
      }),
    );
    expect(notices).toEqual([
      '⛔ Đã hết limit 7 ngày · Opus · reset lúc 12:00 21/09 (còn 7 ngày). Dùng /model để đổi sang model khác.',
    ]);
    expect(tracker.activeBlock(CHAT)).toBeNull();
  });

  it('clears a block silently when requests are allowed again', async () => {
    await tracker.onRateLimit(CHAT, snapshot({ status: 'rejected', resetsAtMs: clock + HOUR }));
    await tracker.onRateLimit(CHAT, snapshot({ status: 'allowed' }));
    expect(tracker.activeBlock(CHAT)).toBeNull();
    await advance(2 * HOUR);
    expect(notices).toHaveLength(1);
  });

  it('treats a block as inactive once its reset time has passed', async () => {
    await tracker.onRateLimit(CHAT, snapshot({ status: 'rejected', resetsAtMs: clock + MINUTE }));
    clock += 2 * MINUTE;
    expect(tracker.activeBlock(CHAT)).toBeNull();
  });

  it('clearBlock removes the block without a notice', async () => {
    await tracker.onRateLimit(CHAT, snapshot({ status: 'rejected', resetsAtMs: clock + HOUR }));
    tracker.clearBlock(CHAT);
    expect(store.getChat(CHAT).limitBlock).toBeNull();
    await advance(2 * HOUR);
    expect(notices).toHaveLength(1);
  });
});

describe('limit errors without an event', () => {
  it('uses the exhausted global usage window', async () => {
    usageResult = report([
      { key: 'seven_day', label: '7 ngày', scope: 'global', utilizationPercent: 60, resetsAtMs: clock + 3 * DAY },
      { key: 'five_hour', label: '5 giờ', scope: 'global', utilizationPercent: 100, resetsAtMs: clock + 30 * MINUTE },
    ]);
    await tracker.onLimitError(CHAT);
    expect(notices).toEqual([
      '⛔ Đã hết limit 5 giờ · reset lúc 12:30 (còn 30 phút). Session vẫn giữ — nhắn lại sau khi reset.',
    ]);
    expect(tracker.activeBlock(CHAT)).toEqual({ limitType: 'five_hour', label: '5 giờ', resetsAtMs: clock + 30 * MINUTE });
  });

  it('prefers an exhausted global window over an earlier model-scoped one', async () => {
    usageResult = report([
      { key: 'model:Opus', label: '7 ngày · Opus', scope: 'model', utilizationPercent: 100, resetsAtMs: clock + MINUTE },
      { key: 'seven_day', label: '7 ngày', scope: 'global', utilizationPercent: 100, resetsAtMs: clock + DAY },
    ]);
    await tracker.onLimitError(CHAT);
    expect(tracker.activeBlock(CHAT)).toEqual({ limitType: 'seven_day', label: '7 ngày', resetsAtMs: clock + DAY });
  });

  it('suggests another model when only a model-scoped window is exhausted', async () => {
    usageResult = report([
      { key: 'model:Opus', label: '7 ngày · Opus', scope: 'model', utilizationPercent: 100, resetsAtMs: clock + HOUR },
    ]);
    await tracker.onLimitError(CHAT);
    expect(notices).toEqual([
      '⛔ Đã hết limit 7 ngày · Opus · reset lúc 13:00 (còn 1 giờ). Dùng /model để đổi sang model khác.',
    ]);
    expect(tracker.activeBlock(CHAT)).toBeNull();
  });

  it('does nothing when a block is already active', async () => {
    await tracker.onRateLimit(CHAT, snapshot({ status: 'rejected', resetsAtMs: clock + HOUR }));
    await tracker.onLimitError(CHAT);
    expect(fetchCount).toBe(0);
    expect(notices).toHaveLength(1);
  });

  it('reports a transient rate limit when no window is exhausted', async () => {
    usageResult = report([
      { key: 'five_hour', label: '5 giờ', scope: 'global', utilizationPercent: 40, resetsAtMs: clock + HOUR },
    ]);
    await tracker.onLimitError(CHAT);
    expect(notices).toEqual(['⛔ Agent đang bị giới hạn (rate limit). Thử lại sau ít phút.']);
    expect(tracker.activeBlock(CHAT)).toBeNull();
  });

  it('reports when the usage lookup fails', async () => {
    usageResult = new Error('boom');
    await tracker.onLimitError(CHAT);
    expect(notices).toEqual([
      '⛔ Agent báo đã hết limit nhưng không lấy được giờ reset: boom. Session vẫn giữ — thử lại sau.',
    ]);
    expect(tracker.activeBlock(CHAT)).toBeNull();
  });

  it('reports a generic limit when the provider cannot report usage', async () => {
    const withoutUsage = createTracker(false);
    await withoutUsage.onLimitError(CHAT);
    expect(notices).toEqual(['⛔ Agent báo đã hết limit. Session vẫn giữ — thử lại sau.']);
    expect(fetchCount).toBe(0);
    withoutUsage.dispose();
  });
});

describe('restore', () => {
  it('announces resets that happened while the bot was down and schedules future ones', async () => {
    store.updateChat(1, { limitBlock: { limitType: 'five_hour', label: '5 giờ', resetsAtMs: clock - MINUTE } });
    store.updateChat(2, { limitBlock: { limitType: 'seven_day', label: '7 ngày', resetsAtMs: clock + HOUR } });
    const restarted = createTracker();
    await restarted.restore();
    expect(notices).toEqual(['✅ Limit 5 giờ đã reset — dùng tiếp được.']);
    expect(store.getChat(1).limitBlock).toBeNull();

    await advance(HOUR + 5_000);
    expect(notices.at(-1)).toBe('✅ Limit 7 ngày đã reset — dùng tiếp được.');
    restarted.dispose();
  });
});

describe('api retries', () => {
  it('notifies at most once a minute per chat', async () => {
    await tracker.onApiRetry(CHAT, { attempt: 1, maxRetries: 10, delayMs: 30_000, error: 'overloaded' });
    await tracker.onApiRetry(CHAT, { attempt: 2, maxRetries: 10, delayMs: 30_000, error: 'overloaded' });
    expect(notices).toEqual(['⏳ API đang quá tải — đang thử lại (lần 1/10, sau 30 giây)']);

    clock += 61_000;
    await tracker.onApiRetry(CHAT, { attempt: 3, maxRetries: 10, delayMs: 65_000, error: 'rate_limit' });
    await tracker.onApiRetry(8, { attempt: 1, maxRetries: 10, delayMs: 1_000, error: 'weird_code' });
    expect(notices.slice(1)).toEqual([
      '⏳ API đang bị giới hạn tốc độ — đang thử lại (lần 3/10, sau 1 phút)',
      '⏳ API weird_code — đang thử lại (lần 1/10, sau 1 giây)',
    ]);
  });
});

describe('dispose', () => {
  it('cancels scheduled reset notices', async () => {
    await tracker.onRateLimit(CHAT, snapshot({ status: 'rejected', resetsAtMs: clock + HOUR }));
    tracker.dispose();
    await advance(2 * HOUR);
    expect(notices).toHaveLength(1);
  });
});
