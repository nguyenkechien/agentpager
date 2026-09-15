import type { Logger } from 'pino';
import type { LimitSnapshot, UsageReport, UsageWindow } from '../../providers/types.js';
import { formatClock, formatDuration } from '../../util/time.js';
import type { StateStore } from './store.js';

export interface ApiRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
}

export interface ActiveLimitBlock {
  limitType: string | null;
  label: string;
  resetsAtMs: number;
}

export interface LimitTrackerDeps {
  store: StateStore;
  notifier: { sendNotice(chatId: number, text: string): Promise<void> };
  /** null when the provider cannot report usage. */
  fetchUsage: (() => Promise<UsageReport>) | null;
  now: () => number;
  logger: Logger;
}

const RESET_SLACK_MS = 5_000;
const RETRY_NOTICE_INTERVAL_MS = 60_000;
const WARNING_KEYS_CAP = 20;
const RETRY_REASONS: Record<string, string> = {
  rate_limit: 'is rate limited',
  overloaded: 'is overloaded',
  server_error: 'server error',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Global windows first (they block everything), then the one that resets soonest. */
function compareExhausted(a: UsageWindow, b: UsageWindow): number {
  if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
  return (a.resetsAtMs ?? Number.POSITIVE_INFINITY) - (b.resetsAtMs ?? Number.POSITIVE_INFINITY);
}

export class LimitTracker {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly lastRetryNotice = new Map<number, number>();

  constructor(private readonly deps: LimitTrackerDeps) {}

  async onRateLimit(chatId: number, snapshot: LimitSnapshot): Promise<void> {
    switch (snapshot.status) {
      case 'allowed':
        this.clearBlock(chatId);
        return;
      case 'allowed_warning': {
        const key = `warn:${snapshot.windowKey ?? 'unknown'}:${snapshot.resetsAtMs ?? 'none'}:${snapshot.threshold ?? 'none'}`;
        if (!this.remember(chatId, key)) return;
        const used = snapshot.utilizationPercent !== null ? `: ${snapshot.utilizationPercent}% used` : '';
        await this.notify(chatId, `⚠️ Approaching the ${snapshot.windowLabel} limit${used}${this.resetPart(snapshot.resetsAtMs)}`);
        return;
      }
      case 'rejected':
        if (snapshot.scope === 'model') {
          await this.rejectModelScoped(chatId, snapshot.windowKey ?? 'unknown', snapshot.windowLabel, snapshot.resetsAtMs);
          return;
        }
        await this.block(chatId, snapshot.windowKey, snapshot.windowLabel, snapshot.resetsAtMs);
        return;
    }
  }

  /** Fallback for a limit stop that arrived without a `rejected` rate limit event. */
  async onLimitError(chatId: number): Promise<void> {
    if (this.activeBlock(chatId)) return;
    if (!this.deps.fetchUsage) {
      await this.notify(chatId, '⛔ The agent reports that the limit is reached. Your session is kept — try again later.');
      return;
    }

    let windows: UsageWindow[];
    try {
      windows = (await this.deps.fetchUsage()).windows;
    } catch (error) {
      this.deps.logger.warn({ err: error, chatId }, 'usage lookup after a limit error failed');
      await this.notify(
        chatId,
        `⛔ The agent reports that the limit is reached, but the reset time could not be fetched: ${messageOf(error)}. Your session is kept — try again later.`,
      );
      return;
    }

    const exhausted = windows.filter((window) => (window.utilizationPercent ?? 0) >= 100).sort(compareExhausted)[0];
    if (!exhausted) {
      await this.notify(chatId, '⛔ The agent is rate limited. Try again in a few minutes.');
      return;
    }
    if (exhausted.scope === 'model') {
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
      `⏳ API ${reason} — retrying (attempt ${retry.attempt}/${retry.maxRetries}, in ${formatDuration(retry.delayMs)})`,
    );
  }

  activeBlock(chatId: number): ActiveLimitBlock | null {
    const block = this.deps.store.getChat(chatId).limitBlock;
    if (!block || block.resetsAtMs === null || this.deps.now() >= block.resetsAtMs) return null;
    return { limitType: block.limitType, label: block.label, resetsAtMs: block.resetsAtMs };
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
        await this.notify(chat.chatId, `✅ The ${block.label} limit has reset — you can continue.`);
      } else {
        this.scheduleReset(chat.chatId, block.limitType, block.label, block.resetsAtMs);
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

    this.deps.store.updateChat(chatId, { limitBlock: { limitType, label, resetsAtMs } });
    if (resetsAtMs !== null) this.scheduleReset(chatId, limitType, label, resetsAtMs);
    await this.notify(chatId, `⛔ Reached the ${label} limit${this.resetPart(resetsAtMs)}. Your session is kept — send a message again after the reset.`);
  }

  private async rejectModelScoped(chatId: number, key: string, label: string, resetsAtMs: number | null): Promise<void> {
    if (!this.remember(chatId, `reject:${key}:${resetsAtMs ?? 'none'}`)) return;
    await this.notify(chatId, `⛔ Reached the ${label} limit${this.resetPart(resetsAtMs)}. Use /model to switch to another model.`);
  }

  private scheduleReset(chatId: number, limitType: string | null, label: string, resetsAtMs: number): void {
    this.cancelTimer(chatId);
    const delay = Math.max(0, resetsAtMs + RESET_SLACK_MS - this.deps.now());
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      this.announceReset(chatId, limitType, label, resetsAtMs).catch((error: unknown) => {
        this.deps.logger.error({ err: error, chatId }, 'failed to announce limit reset');
      });
    }, delay);
    timer.unref();
    this.timers.set(chatId, timer);
  }

  private async announceReset(chatId: number, limitType: string | null, label: string, resetsAtMs: number): Promise<void> {
    const current = this.deps.store.getChat(chatId).limitBlock;
    if (!current || current.limitType !== limitType || current.resetsAtMs !== resetsAtMs) return;
    this.deps.store.updateChat(chatId, { limitBlock: null });
    await this.notify(chatId, `✅ The ${label} limit has reset — you can continue.`);
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
    return ` · resets at ${formatClock(resetsAtMs, now)} (in ${formatDuration(resetsAtMs - now)})`;
  }

  private async notify(chatId: number, text: string): Promise<void> {
    try {
      await this.deps.notifier.sendNotice(chatId, text);
    } catch (error) {
      this.deps.logger.error({ err: error, chatId }, 'failed to send limit notice');
    }
  }
}
