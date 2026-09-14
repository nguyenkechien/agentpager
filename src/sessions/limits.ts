import type { Logger } from 'pino';
import type { RateLimitSnapshot } from '../claude/runner.js';
import { formatClock, formatDuration } from '../util/time.js';
import type { StateStore } from './store.js';

export interface UsageWindow {
  key: string;
  label: string;
  utilizationPercent: number | null;
  resetsAtMs: number | null;
}

export interface UsageReport {
  subscription: string | null;
  available: boolean;
  extraUsageEnabled: boolean;
  windows: UsageWindow[];
}

export interface UsageSource {
  fetch(): Promise<UsageReport>;
}

export interface ApiRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
}

export interface LimitTrackerDeps {
  store: StateStore;
  notifier: { sendNotice(chatId: number, text: string): Promise<void> };
  usage: UsageSource;
  now: () => number;
  logger: Logger;
}

const LABELS: Record<string, string> = {
  five_hour: '5 giờ',
  seven_day: '7 ngày',
  seven_day_overage_included: '7 ngày',
  seven_day_opus: '7 ngày · Opus',
  seven_day_sonnet: '7 ngày · Sonnet',
  overage: 'usage credits',
};
const MODEL_SCOPED = new Set(['seven_day_opus', 'seven_day_sonnet']);
const WINDOW_PRIORITY = ['five_hour', 'seven_day'];
const RESET_SLACK_MS = 5_000;
const RETRY_NOTICE_INTERVAL_MS = 60_000;
const WARNING_KEYS_CAP = 20;
const RETRY_REASONS: Record<string, string> = {
  rate_limit: 'đang bị giới hạn tốc độ',
  overloaded: 'đang quá tải',
  server_error: 'lỗi server',
};

export function isModelScopedLimit(limitType: string | null): boolean {
  return limitType !== null && MODEL_SCOPED.has(limitType);
}

export function limitLabel(limitType: string | null): string {
  return (limitType !== null ? LABELS[limitType] : undefined) ?? 'hiện tại';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function windowRank(key: string): number {
  const index = WINDOW_PRIORITY.indexOf(key);
  return index === -1 ? WINDOW_PRIORITY.length : index;
}

export class LimitTracker {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly lastRetryNotice = new Map<number, number>();

  constructor(private readonly deps: LimitTrackerDeps) {}

  async onRateLimit(chatId: number, snapshot: RateLimitSnapshot): Promise<void> {
    switch (snapshot.status) {
      case 'allowed':
        this.clearBlock(chatId);
        return;
      case 'allowed_warning': {
        const key = `warn:${snapshot.limitType ?? 'unknown'}:${snapshot.resetsAtMs ?? 'none'}:${snapshot.threshold ?? 'none'}`;
        if (!this.remember(chatId, key)) return;
        const used = snapshot.utilizationPercent !== null ? `: đã dùng ${snapshot.utilizationPercent}%` : '';
        await this.notify(chatId, `⚠️ Sắp chạm limit ${limitLabel(snapshot.limitType)}${used}${this.resetPart(snapshot.resetsAtMs)}`);
        return;
      }
      case 'rejected':
        if (snapshot.limitType !== null && MODEL_SCOPED.has(snapshot.limitType)) {
          await this.rejectModelScoped(chatId, snapshot.limitType, limitLabel(snapshot.limitType), snapshot.resetsAtMs);
          return;
        }
        await this.block(chatId, snapshot.limitType, limitLabel(snapshot.limitType), snapshot.resetsAtMs);
        return;
    }
  }

  /** Fallback for a limit stop that arrived without a `rejected` rate limit event. */
  async onLimitError(chatId: number): Promise<void> {
    if (this.activeBlock(chatId)) return;

    let windows: UsageWindow[];
    try {
      windows = (await this.deps.usage.fetch()).windows;
    } catch (error) {
      this.deps.logger.warn({ err: error, chatId }, 'usage lookup after a limit error failed');
      await this.notify(
        chatId,
        `⛔ Claude báo đã hết limit nhưng không lấy được giờ reset: ${messageOf(error)}. Session vẫn giữ — thử lại sau.`,
      );
      return;
    }

    const exhausted = windows
      .filter((window) => (window.utilizationPercent ?? 0) >= 100)
      .sort((a, b) => windowRank(a.key) - windowRank(b.key))[0];
    if (!exhausted) {
      await this.notify(chatId, '⛔ Claude đang bị giới hạn (rate limit). Thử lại sau ít phút.');
      return;
    }
    if (MODEL_SCOPED.has(exhausted.key) || exhausted.key.startsWith('model:')) {
      await this.rejectModelScoped(chatId, exhausted.key, exhausted.label, exhausted.resetsAtMs);
      return;
    }
    await this.block(chatId, exhausted.key, exhausted.label, exhausted.resetsAtMs);
  }

  async onApiRetry(chatId: number, retry: ApiRetryInfo): Promise<void> {
    const now = this.deps.now();
    const last = this.lastRetryNotice.get(chatId);
    if (last !== undefined && now - last < RETRY_NOTICE_INTERVAL_MS) return;
    this.lastRetryNotice.set(chatId, now);

    const reason = RETRY_REASONS[retry.error] ?? retry.error;
    await this.notify(
      chatId,
      `⏳ API ${reason} — đang thử lại (lần ${retry.attempt}/${retry.maxRetries}, sau ${formatDuration(retry.delayMs)})`,
    );
  }

  activeBlock(chatId: number): { limitType: string | null; resetsAtMs: number } | null {
    const block = this.deps.store.getChat(chatId).limitBlock;
    if (!block || block.resetsAtMs === null || this.deps.now() >= block.resetsAtMs) return null;
    return { limitType: block.limitType, resetsAtMs: block.resetsAtMs };
  }

  clearBlock(chatId: number): void {
    this.cancelTimer(chatId);
    if (this.deps.store.getChat(chatId).limitBlock) this.deps.store.updateChat(chatId, { limitBlock: null });
  }

  /** Re-arms reset notices after a restart and announces resets that happened while the bot was down. */
  async restore(): Promise<void> {
    const now = this.deps.now();
    for (const chat of this.deps.store.allChats()) {
      const block = chat.limitBlock;
      if (!block || block.resetsAtMs === null) continue;
      if (block.resetsAtMs <= now) {
        this.deps.store.updateChat(chat.chatId, { limitBlock: null });
        await this.notify(chat.chatId, `✅ Limit ${limitLabel(block.limitType)} đã reset — dùng tiếp được.`);
      } else {
        this.scheduleReset(chat.chatId, block.limitType, block.resetsAtMs);
      }
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async block(chatId: number, limitType: string | null, label: string, resetsAtMs: number | null): Promise<void> {
    const current = this.deps.store.getChat(chatId).limitBlock;
    if (current && current.limitType === limitType && current.resetsAtMs === resetsAtMs) return;

    this.deps.store.updateChat(chatId, { limitBlock: { limitType, resetsAtMs } });
    if (resetsAtMs !== null) this.scheduleReset(chatId, limitType, resetsAtMs);
    await this.notify(chatId, `⛔ Đã hết limit ${label}${this.resetPart(resetsAtMs)}. Session vẫn giữ — nhắn lại sau khi reset.`);
  }

  private async rejectModelScoped(chatId: number, key: string, label: string, resetsAtMs: number | null): Promise<void> {
    if (!this.remember(chatId, `reject:${key}:${resetsAtMs ?? 'none'}`)) return;
    await this.notify(chatId, `⛔ Đã hết limit ${label}${this.resetPart(resetsAtMs)}. Dùng /model để đổi sang model khác.`);
  }

  private scheduleReset(chatId: number, limitType: string | null, resetsAtMs: number): void {
    this.cancelTimer(chatId);
    const delay = Math.max(0, resetsAtMs + RESET_SLACK_MS - this.deps.now());
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      this.announceReset(chatId, limitType, resetsAtMs).catch((error: unknown) => {
        this.deps.logger.error({ err: error, chatId }, 'failed to announce limit reset');
      });
    }, delay);
    timer.unref();
    this.timers.set(chatId, timer);
  }

  private async announceReset(chatId: number, limitType: string | null, resetsAtMs: number): Promise<void> {
    const current = this.deps.store.getChat(chatId).limitBlock;
    if (!current || current.limitType !== limitType || current.resetsAtMs !== resetsAtMs) return;
    this.deps.store.updateChat(chatId, { limitBlock: null });
    await this.notify(chatId, `✅ Limit ${limitLabel(limitType)} đã reset — dùng tiếp được.`);
  }

  private cancelTimer(chatId: number): void {
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
  }

  /** Records a dedupe key; returns false when it was already recorded. */
  private remember(chatId: number, key: string): boolean {
    const keys = this.deps.store.getChat(chatId).limitWarnings;
    if (keys.includes(key)) return false;
    this.deps.store.updateChat(chatId, { limitWarnings: [...keys, key].slice(-WARNING_KEYS_CAP) });
    return true;
  }

  private resetPart(resetsAtMs: number | null): string {
    if (resetsAtMs === null) return '';
    const now = this.deps.now();
    return ` · reset lúc ${formatClock(resetsAtMs, now)} (còn ${formatDuration(resetsAtMs - now)})`;
  }

  private async notify(chatId: number, text: string): Promise<void> {
    try {
      await this.deps.notifier.sendNotice(chatId, text);
    } catch (error) {
      this.deps.logger.error({ err: error, chatId }, 'failed to send limit notice');
    }
  }
}
