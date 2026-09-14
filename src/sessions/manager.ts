import type { Logger } from 'pino';
import type { PromptBroker } from '../claude/prompts.js';
import type { Runner, RunningTurn, TurnEvent, TurnInput, TurnOutcome } from '../claude/runner.js';
import type { Effort, ModelAlias } from '../config.js';
import type { StateStore } from './store.js';

export interface Notifier {
  sendMarkdown(chatId: number, markdown: string): Promise<void>;
  sendNotice(chatId: number, text: string): Promise<void>;
  setTyping(chatId: number, active: boolean): void;
}

export const QUEUE_CAP = 10;
const DEFAULT_STOP_GRACE_MS = 10_000;
const DEFAULT_IDLE_CHECK_MS = 60_000;
const TITLE_LENGTH = 60;

export type SubmitResult = { kind: 'started' } | { kind: 'queued'; position: number } | { kind: 'queue_full' };
export type BusyResult = 'ok' | 'busy';
export type StopResult = { kind: 'idle' } | { kind: 'stopping'; dropped: number };

export interface StatusSnapshot {
  cwd: string;
  sessionId: string | null;
  runningSinceMs: number | null;
  currentTool: string | null;
  waitingForUser: boolean;
  queueLength: number;
  idleRemainingMs: number | null;
  model: ModelAlias | null;
  effort: Effort | null;
  lastTurnCostUsd: number | null;
}

export interface SessionManagerDeps {
  store: StateStore;
  runner: Runner;
  notifier: Notifier;
  broker: Pick<PromptBroker, 'hasPending' | 'cancelPending'>;
  idleTimeoutMs: number;
  now: () => number;
  logger: Logger;
  stopGraceMs?: number;
}

interface QueuedInput {
  input: TurnInput;
  title: string;
}

interface ActiveTurn {
  turn: RunningTurn;
  title: string;
  startedAt: number;
  currentTool: string | null;
  stopRequested: boolean;
  graceTimer: NodeJS.Timeout | null;
  completed: Promise<void>;
}

function normalizeTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, TITLE_LENGTH) : '(không có tiêu đề)';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

export class SessionManager {
  private readonly running = new Map<number, ActiveTurn>();
  private readonly queues = new Map<number, QueuedInput[]>();
  private readonly stopGraceMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(private readonly deps: SessionManagerDeps) {
    this.stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  async recoverAfterRestart(): Promise<void> {
    const { store, notifier } = this.deps;
    for (const chat of store.allChats()) {
      if (chat.runningSince === null) continue;
      store.updateChat(chat.chatId, { runningSince: null });
      const startedAt = new Date(chat.runningSince).toLocaleString('vi-VN');
      await this.notify(() =>
        notifier.sendNotice(
          chat.chatId,
          `⚠️ Bot vừa khởi động lại; lượt đang chạy từ ${startedAt} đã bị gián đoạn (hàng đợi cũng mất). Session vẫn còn — nhắn tiếp để tiếp tục.`,
        ),
      );
    }
    await this.flushStore();
  }

  startIdleTimer(intervalMs: number = DEFAULT_IDLE_CHECK_MS): void {
    this.stopIdleTimer();
    this.idleTimer = setInterval(() => {
      this.checkIdle().catch((error: unknown) => {
        this.deps.logger.error({ err: error }, 'idle check failed');
      });
    }, intervalMs);
    this.idleTimer.unref();
  }

  stopIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  async checkIdle(): Promise<void> {
    for (const chat of this.deps.store.allChats()) {
      await this.expireIfIdle(chat.chatId);
    }
  }

  async submit(chatId: number, input: TurnInput, title: string): Promise<SubmitResult> {
    if (this.running.has(chatId)) {
      const queue = this.queues.get(chatId) ?? [];
      if (queue.length >= QUEUE_CAP) return { kind: 'queue_full' };
      queue.push({ input, title });
      this.queues.set(chatId, queue);
      return { kind: 'queued', position: queue.length };
    }
    await this.expireIfIdle(chatId);
    this.startTurn(chatId, { input, title });
    return { kind: 'started' };
  }

  isBusy(chatId: number): boolean {
    return this.running.has(chatId);
  }

  newSession(chatId: number): BusyResult {
    if (this.isBusy(chatId)) return 'busy';
    this.deps.store.updateChat(chatId, { activeSessionId: null });
    return 'ok';
  }

  resume(chatId: number, target: { sessionId: string; cwd: string; title: string }): BusyResult {
    if (this.isBusy(chatId)) return 'busy';
    const { store, now } = this.deps;
    const at = now();
    store.updateChat(chatId, { activeSessionId: target.sessionId, cwd: target.cwd, lastActivityAt: at });
    const existing = store.findSession(target.sessionId);
    store.upsertSession(
      existing
        ? { ...existing, lastActiveAt: at }
        : {
            sessionId: target.sessionId,
            chatId,
            cwd: target.cwd,
            title: normalizeTitle(target.title),
            createdAt: at,
            lastActiveAt: at,
          },
    );
    return 'ok';
  }

  setProject(chatId: number, cwd: string): BusyResult | 'unchanged' {
    if (this.isBusy(chatId)) return 'busy';
    if (this.deps.store.getChat(chatId).cwd === cwd) return 'unchanged';
    this.deps.store.updateChat(chatId, { cwd, activeSessionId: null });
    return 'ok';
  }

  setModel(chatId: number, model: ModelAlias | null): void {
    this.deps.store.updateChat(chatId, { model });
  }

  setEffort(chatId: number, effort: Effort | null): void {
    this.deps.store.updateChat(chatId, { effort });
  }

  async stop(chatId: number): Promise<StopResult> {
    const active = this.running.get(chatId);
    if (!active) return { kind: 'idle' };

    const dropped = this.queues.get(chatId)?.length ?? 0;
    this.queues.delete(chatId);
    this.deps.broker.cancelPending(chatId);
    await this.requestStop(chatId, active, true);
    return { kind: 'stopping', dropped };
  }

  status(chatId: number): StatusSnapshot {
    const { store, broker, idleTimeoutMs, now } = this.deps;
    const chat = store.getChat(chatId);
    const active = this.running.get(chatId);
    const idleRemainingMs =
      chat.activeSessionId !== null && !active ? Math.max(0, chat.lastActivityAt + idleTimeoutMs - now()) : null;
    return {
      cwd: chat.cwd,
      sessionId: chat.activeSessionId,
      runningSinceMs: active ? active.startedAt : null,
      currentTool: active?.currentTool ?? null,
      waitingForUser: broker.hasPending(chatId),
      queueLength: this.queues.get(chatId)?.length ?? 0,
      idleRemainingMs,
      model: chat.model,
      effort: chat.effort,
      lastTurnCostUsd: chat.lastTurnCostUsd,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopIdleTimer();
    this.queues.clear();
    const turns = [...this.running.entries()];
    await Promise.all(
      turns.map(async ([chatId, active]) => {
        this.deps.broker.cancelPending(chatId);
        await this.requestStop(chatId, active, false);
        const grace = delay(this.stopGraceMs);
        await Promise.race([active.completed, grace.promise]);
        grace.cancel();
        if (this.running.get(chatId) === active) active.turn.abort();
      }),
    );
    await this.flushStore();
  }

  private async expireIfIdle(chatId: number): Promise<void> {
    const { store, broker, idleTimeoutMs, now, notifier } = this.deps;
    const chat = store.getChat(chatId);
    if (chat.activeSessionId === null || chat.runningSince !== null) return;
    if (this.running.has(chatId) || (this.queues.get(chatId)?.length ?? 0) > 0 || broker.hasPending(chatId)) return;
    if (now() - chat.lastActivityAt <= idleTimeoutMs) return;

    store.updateChat(chatId, { activeSessionId: null });
    const minutes = Math.round(idleTimeoutMs / 60_000);
    await this.notify(() =>
      notifier.sendNotice(
        chatId,
        `💤 Phiên đã kết thúc sau ${minutes} phút không hoạt động. Tin nhắn tiếp theo sẽ mở phiên mới. /resume để quay lại.`,
      ),
    );
    await this.flushStore();
  }

  private startTurn(chatId: number, queued: QueuedInput): void {
    const { store, runner, notifier, now } = this.deps;
    const startedAt = now();
    const chat = store.updateChat(chatId, { runningSince: startedAt, lastActivityAt: startedAt });
    notifier.setTyping(chatId, true);

    let active: ActiveTurn | null = null;
    const turn = runner.start(
      {
        chatId,
        cwd: chat.cwd,
        resumeSessionId: chat.activeSessionId,
        model: chat.model,
        effort: chat.effort,
        input: queued.input,
      },
      (event) => {
        if (active) this.handleEvent(chatId, active, event);
      },
    );
    const state: ActiveTurn = {
      turn,
      title: queued.title,
      startedAt,
      currentTool: null,
      stopRequested: false,
      graceTimer: null,
      completed: Promise.resolve(),
    };
    active = state;
    this.running.set(chatId, state);
    state.completed = this.completeTurn(chatId, state);
  }

  private handleEvent(chatId: number, active: ActiveTurn, event: TurnEvent): void {
    const { store, now } = this.deps;
    const at = now();
    if (event.type === 'tool') {
      active.currentTool = event.name;
    }
    if (event.type !== 'session') {
      store.updateChat(chatId, { lastActivityAt: at });
      return;
    }

    const chat = store.getChat(chatId);
    const existing = store.findSession(event.sessionId);
    store.updateChat(chatId, { activeSessionId: event.sessionId, lastActivityAt: at });
    store.upsertSession(
      existing
        ? { ...existing, lastActiveAt: at }
        : {
            sessionId: event.sessionId,
            chatId,
            cwd: chat.cwd,
            title: normalizeTitle(active.title),
            createdAt: at,
            lastActiveAt: at,
          },
    );
  }

  private async completeTurn(chatId: number, active: ActiveTurn): Promise<void> {
    const { notifier, logger } = this.deps;
    let outcome: TurnOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await active.turn.done;
    } catch (error) {
      failure = error;
    }

    if (active.graceTimer) clearTimeout(active.graceTimer);
    notifier.setTyping(chatId, false);

    if (active.stopRequested) {
      if (failure) logger.info({ err: failure, chatId }, 'stopped turn ended with an error');
      await this.notify(() => notifier.sendNotice(chatId, '⏹ Đã dừng.'));
    } else if (failure) {
      logger.error({ err: failure, chatId }, 'Claude turn failed');
      await this.notify(() => notifier.sendNotice(chatId, `❌ Lỗi: ${messageOf(failure)}`));
    } else if (outcome?.kind === 'success') {
      const text = outcome.text.trim() ? outcome.text : '✅ Xong (không có nội dung trả lời).';
      await this.notify(() => notifier.sendMarkdown(chatId, text));
    } else if (outcome) {
      const details = outcome.errors.length > 0 ? `: ${outcome.errors.join('; ')}` : '';
      await this.notify(() => notifier.sendNotice(chatId, `❌ ${outcome.subtype}${details}`));
    }

    this.finishTurn(chatId, active, outcome?.costUsd ?? null);

    // Start the next queued input before persisting; the flush below also captures the new turn's state.
    const next = this.queues.get(chatId)?.shift();
    if (this.queues.get(chatId)?.length === 0) this.queues.delete(chatId);
    if (next && !this.shuttingDown) this.startTurn(chatId, next);
    await this.flushStore();
  }

  private finishTurn(chatId: number, active: ActiveTurn, costUsd: number | null): void {
    const { store, now } = this.deps;
    const at = now();
    if (this.running.get(chatId) === active) this.running.delete(chatId);
    const chat = store.updateChat(chatId, {
      runningSince: null,
      lastActivityAt: at,
      ...(costUsd !== null ? { lastTurnCostUsd: costUsd } : {}),
    });
    if (chat.activeSessionId) {
      const record = store.findSession(chat.activeSessionId);
      if (record) store.upsertSession({ ...record, lastActiveAt: at });
    }
  }

  private async requestStop(chatId: number, active: ActiveTurn, withGraceAbort: boolean): Promise<void> {
    const { logger, notifier } = this.deps;
    active.stopRequested = true;
    try {
      await active.turn.interrupt();
    } catch (error) {
      logger.error({ err: error, chatId }, 'interrupt failed; aborting the Claude process');
      active.turn.abort();
      return;
    }
    if (!withGraceAbort) return;

    active.graceTimer = setTimeout(() => {
      if (this.running.get(chatId) !== active) return;
      active.turn.abort();
      const seconds = Math.round(this.stopGraceMs / 1000);
      void this.notify(() =>
        notifier.sendNotice(chatId, `⚠️ Không dừng được sau ${seconds} giây — đã huỷ tiến trình.`),
      );
    }, this.stopGraceMs);
  }

  private async notify(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.deps.logger.error({ err: error }, 'failed to notify Telegram user');
    }
  }

  private async flushStore(): Promise<void> {
    try {
      await this.deps.store.flush();
    } catch (error) {
      this.deps.logger.error({ err: error }, 'failed to persist state');
    }
  }
}
