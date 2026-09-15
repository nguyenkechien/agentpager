import type { Logger } from 'pino';
import type { AgentProvider, RunningTurn, TurnEvent, TurnInput, TurnOutcome } from '../../providers/types.js';
import type { PromptBroker } from '../prompts/broker.js';
import type { LimitTracker } from './limits.js';
import type { StateStore } from './store.js';

export interface Notifier {
  sendMarkdown(chatId: number, markdown: string): Promise<void>;
  sendNotice(chatId: number, text: string): Promise<void>;
  setTyping(chatId: number, active: boolean): void;
}

export type LimitHooks = Pick<LimitTracker, 'onRateLimit' | 'onLimitError' | 'onApiRetry' | 'activeBlock' | 'clearBlock'>;
export type TurnProvider = Pick<AgentProvider, 'startTurn' | 'capabilities' | 'displayName' | 'models' | 'efforts'>;

export const QUEUE_CAP = 10;
const DEFAULT_STOP_GRACE_MS = 10_000;
const DEFAULT_IDLE_CHECK_MS = 60_000;
const TITLE_LENGTH = 60;

export type SubmitResult =
  | { kind: 'started' }
  | { kind: 'queued'; position: number }
  | { kind: 'queue_full' }
  | { kind: 'limit_blocked'; label: string; resetsAtMs: number };
export type BusyResult = 'ok' | 'busy';
export type StopResult =
  | { kind: 'idle' }
  | { kind: 'stopping'; dropped: number }
  | { kind: 'finishing'; dropped: number };

export interface StatusSnapshot {
  agent: string;
  guardSupported: boolean;
  cwd: string;
  sessionId: string | null;
  runningSinceMs: number | null;
  currentTool: string | null;
  waitingForUser: boolean;
  queueLength: number;
  idleRemainingMs: number | null;
  model: string | null;
  effort: string | null;
  lastTurnCostUsd: number | null;
  limitBlock: { label: string; resetsAtMs: number } | null;
}

export interface SessionManagerDeps {
  store: StateStore;
  provider: TurnProvider;
  notifier: Notifier;
  broker: Pick<PromptBroker, 'hasPending' | 'cancelPending'>;
  limits: LimitHooks;
  idleTimeoutMs: number;
  now: () => number;
  logger: Logger;
  /** Used to detect a project folder that was deleted or renamed since it was selected. */
  pathExists: (path: string) => Promise<boolean>;
  /** Working directory to fall back to when the chat's project folder no longer exists. */
  fallbackCwd: string;
  stopGraceMs?: number;
  /** Called whenever the number of running turns or queued inputs changes (the daemon reports it). */
  onActivity?: (activity: SessionActivity) => void;
}

/** How busy the agent is across all chats. */
export interface SessionActivity {
  /** Chats with a turn running or about to start. */
  activeTurns: number;
  queuedInputs: number;
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
  resultReceived: boolean;
  stopRequested: boolean;
  /** Set when the turn ended because a global plan limit was reached. */
  limitHit: boolean;
  /** Limit notices triggered by this turn; awaited before the result so messages stay in order. */
  limitWork: Promise<void>[];
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
  /** Chats whose next turn is being prepared (awaiting checks) but not yet registered as running. */
  private readonly starting = new Set<number>();
  private readonly stopGraceMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private lastActivity: SessionActivity = { activeTurns: 0, queuedInputs: 0 };

  constructor(private readonly deps: SessionManagerDeps) {
    this.stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  activity(): SessionActivity {
    let queuedInputs = 0;
    for (const queue of this.queues.values()) queuedInputs += queue.length;
    return { activeTurns: new Set([...this.running.keys(), ...this.starting]).size, queuedInputs };
  }

  async recoverAfterRestart(): Promise<void> {
    const { store, notifier, now } = this.deps;
    for (const chat of store.allChats()) {
      if (chat.runningSince === null) continue;
      // The notice promises the session can be continued, so the idle clock restarts from the notice.
      store.updateChat(chat.chatId, { runningSince: null, lastActivityAt: now() });
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
    const block = this.deps.limits.activeBlock(chatId);
    if (block) return { kind: 'limit_blocked', label: block.label, resetsAtMs: block.resetsAtMs };

    if (this.isBusy(chatId)) {
      const queue = this.queues.get(chatId) ?? [];
      if (queue.length >= QUEUE_CAP) return { kind: 'queue_full' };
      queue.push({ input, title });
      this.queues.set(chatId, queue);
      this.reportActivity();
      return { kind: 'queued', position: queue.length };
    }

    this.starting.add(chatId);
    this.reportActivity();
    try {
      await this.expireIfIdle(chatId);
      await this.ensureCwd(chatId);
      this.startTurn(chatId, { input, title });
    } finally {
      this.starting.delete(chatId);
      this.reportActivity();
    }
    return { kind: 'started' };
  }

  isBusy(chatId: number): boolean {
    return this.running.has(chatId) || this.starting.has(chatId);
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

  setModel(chatId: number, model: string | null): void {
    this.deps.store.updateChat(chatId, { model });
  }

  setEffort(chatId: number, effort: string | null): void {
    this.deps.store.updateChat(chatId, { effort });
  }

  /** Never waits for the agent process, so a hung interrupt cannot block Telegram update handling. */
  stop(chatId: number): StopResult {
    const active = this.running.get(chatId);
    if (!active) return { kind: 'idle' };

    const dropped = this.queues.get(chatId)?.length ?? 0;
    this.queues.delete(chatId);
    this.reportActivity();
    this.deps.broker.cancelPending(chatId);
    // Once the result exists the answer is delivered; the process is only shutting down.
    if (active.resultReceived) return { kind: 'finishing', dropped };

    if (this.deps.provider.capabilities.interrupt === 'kill') {
      active.stopRequested = true;
      active.turn.abort();
      return { kind: 'stopping', dropped };
    }
    this.requestStop(chatId, active);
    this.startGraceAbort(chatId, active);
    return { kind: 'stopping', dropped };
  }

  status(chatId: number): StatusSnapshot {
    const { store, broker, limits, provider, idleTimeoutMs, now } = this.deps;
    const chat = store.getChat(chatId);
    const active = this.running.get(chatId);
    const idleRemainingMs =
      chat.activeSessionId !== null && !active ? Math.max(0, chat.lastActivityAt + idleTimeoutMs - now()) : null;
    const block = limits.activeBlock(chatId);
    return {
      agent: provider.displayName,
      guardSupported: provider.capabilities.commandGuard,
      cwd: chat.cwd,
      sessionId: chat.activeSessionId,
      runningSinceMs: active ? active.startedAt : null,
      currentTool: active?.currentTool ?? null,
      waitingForUser: broker.hasPending(chatId),
      queueLength: this.queues.get(chatId)?.length ?? 0,
      idleRemainingMs,
      model: this.offeredModel(chat.model),
      effort: this.offeredEffort(chat.effort),
      lastTurnCostUsd: chat.lastTurnCostUsd,
      limitBlock: block ? { label: block.label, resetsAtMs: block.resetsAtMs } : null,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopIdleTimer();
    this.queues.clear();
    this.reportActivity();
    await Promise.all(
      [...this.running.entries()].map(async ([chatId, active]) => {
        this.deps.broker.cancelPending(chatId);
        if (this.deps.provider.capabilities.interrupt === 'kill') {
          active.stopRequested = true;
          active.turn.abort();
        } else if (!active.resultReceived) {
          this.requestStop(chatId, active);
        }
        const grace = delay(this.stopGraceMs);
        await Promise.race([active.completed, grace.promise]);
        grace.cancel();
        if (this.running.get(chatId) === active) active.turn.abort();
      }),
    );
    await this.flushStore();
  }

  private offeredModel(model: string | null): string | null {
    return model !== null && this.deps.provider.models.some((option) => option.id === model) ? model : null;
  }

  private offeredEffort(effort: string | null): string | null {
    return effort !== null && this.deps.provider.efforts.includes(effort) ? effort : null;
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

  /** Falls back to the projects root when the chat's folder was deleted or renamed. */
  private async ensureCwd(chatId: number): Promise<void> {
    const { store, notifier, pathExists, fallbackCwd, logger } = this.deps;
    const cwd = store.getChat(chatId).cwd;
    let exists: boolean;
    try {
      exists = await pathExists(cwd);
    } catch (error) {
      logger.warn({ err: error, chatId, cwd }, 'could not check project folder; treating it as missing');
      exists = false;
    }
    if (exists) return;

    store.updateChat(chatId, { cwd: fallbackCwd, activeSessionId: null });
    await this.notify(() =>
      notifier.sendNotice(chatId, `📁 Thư mục ${cwd} không còn tồn tại — đã chuyển về ${fallbackCwd} và mở phiên mới.`),
    );
  }

  /** Returns false when the provider could not start the turn; state is restored and the user is told. */
  private startTurn(chatId: number, queued: QueuedInput): boolean {
    const { store, provider, notifier, now, logger } = this.deps;
    const startedAt = now();
    const chat = store.updateChat(chatId, { runningSince: startedAt, lastActivityAt: startedAt });
    notifier.setTyping(chatId, true);

    let active: ActiveTurn | null = null;
    let turn: RunningTurn;
    try {
      turn = provider.startTurn(
        {
          chatId,
          cwd: chat.cwd,
          resumeSessionId: chat.activeSessionId,
          model: this.offeredModel(chat.model),
          effort: this.offeredEffort(chat.effort),
          input: queued.input,
        },
        {
          emit: (event) => {
            if (active) this.handleEvent(chatId, active, event);
          },
        },
      );
    } catch (error) {
      logger.error({ err: error, chatId }, 'failed to start agent turn');
      notifier.setTyping(chatId, false);
      store.updateChat(chatId, { runningSince: null });
      void this.notify(() => notifier.sendNotice(chatId, `❌ Lỗi: ${messageOf(error)}`));
      return false;
    }

    const state: ActiveTurn = {
      turn,
      title: queued.title,
      startedAt,
      currentTool: null,
      resultReceived: false,
      stopRequested: false,
      limitHit: false,
      limitWork: [],
      graceTimer: null,
      completed: Promise.resolve(),
    };
    active = state;
    this.running.set(chatId, state);
    this.reportActivity();
    state.completed = this.completeTurn(chatId, state);
    return true;
  }

  private handleEvent(chatId: number, active: ActiveTurn, event: TurnEvent): void {
    const { store, limits, now } = this.deps;
    const at = now();
    switch (event.type) {
      case 'tool':
        active.currentTool = event.name;
        break;
      case 'result':
        active.resultReceived = true;
        break;
      case 'rate_limit':
        if (event.snapshot.status === 'rejected' && event.snapshot.scope === 'global') active.limitHit = true;
        this.trackLimitWork(chatId, active, limits.onRateLimit(chatId, event.snapshot));
        break;
      case 'limit_error':
        active.limitHit = true;
        break;
      case 'api_retry':
        this.trackLimitWork(
          chatId,
          active,
          limits.onApiRetry(chatId, {
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
            error: event.error,
          }),
        );
        break;
      case 'activity':
      case 'session':
        break;
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

  private trackLimitWork(chatId: number, active: ActiveTurn, work: Promise<void>): void {
    active.limitWork.push(
      work.catch((error: unknown) => {
        this.deps.logger.error({ err: error, chatId }, 'limit notice handling failed');
      }),
    );
  }

  private async completeTurn(chatId: number, active: ActiveTurn): Promise<void> {
    const { notifier, logger, limits } = this.deps;
    let outcome: TurnOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await active.turn.done;
    } catch (error) {
      failure = error;
    }

    if (active.graceTimer) clearTimeout(active.graceTimer);
    notifier.setTyping(chatId, false);
    await Promise.all(active.limitWork);

    if (active.limitHit && !active.stopRequested) {
      try {
        await limits.onLimitError(chatId);
      } catch (error) {
        logger.error({ err: error, chatId }, 'limit fallback handling failed');
      }
      const dropped = this.queues.get(chatId)?.length ?? 0;
      this.queues.delete(chatId);
      this.reportActivity();
      if (dropped > 0) {
        await this.notify(() => notifier.sendNotice(chatId, `🗑 Đã huỷ ${dropped} tin trong hàng đợi vì hết limit.`));
      }
    }

    if (active.stopRequested) {
      if (failure) logger.info({ err: failure, chatId }, 'stopped turn ended with an error');
      await this.notify(() => notifier.sendNotice(chatId, '⏹ Đã dừng.'));
    } else if (failure) {
      logger.error({ err: failure, chatId }, 'agent turn failed');
      await this.notify(() => notifier.sendNotice(chatId, `❌ Lỗi: ${messageOf(failure)}`));
    } else if (outcome?.kind === 'success') {
      if (!active.limitHit) limits.clearBlock(chatId);
      const text = outcome.text.trim() ? outcome.text : '✅ Xong (không có nội dung trả lời).';
      await this.notify(() => notifier.sendMarkdown(chatId, text));
    } else if (outcome) {
      const details = outcome.errors.length > 0 ? `: ${outcome.errors.join('; ')}` : '';
      await this.notify(() => notifier.sendNotice(chatId, `❌ ${outcome.subtype}${details}`));
    }

    // Keep the chat marked busy while the next queued input is prepared, so new messages keep queueing.
    const hasNext = !this.shuttingDown && (this.queues.get(chatId)?.length ?? 0) > 0;
    if (hasNext) this.starting.add(chatId);
    this.finishTurn(chatId, active, outcome?.costUsd ?? null);

    if (hasNext) {
      try {
        await this.ensureCwd(chatId);
        let next = this.dequeue(chatId);
        while (next && !this.startTurn(chatId, next)) next = this.dequeue(chatId);
      } finally {
        this.starting.delete(chatId);
        this.reportActivity();
      }
    }
    await this.flushStore();
  }

  private dequeue(chatId: number): QueuedInput | undefined {
    const queue = this.queues.get(chatId);
    const next = queue?.shift();
    if (queue?.length === 0) this.queues.delete(chatId);
    this.reportActivity();
    return next;
  }

  private reportActivity(): void {
    const next = this.activity();
    if (next.activeTurns === this.lastActivity.activeTurns && next.queuedInputs === this.lastActivity.queuedInputs) return;
    this.lastActivity = next;
    this.deps.onActivity?.(next);
  }

  private finishTurn(chatId: number, active: ActiveTurn, costUsd: number | null): void {
    const { store, now } = this.deps;
    const at = now();
    if (this.running.get(chatId) === active) this.running.delete(chatId);
    this.reportActivity();
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

  private requestStop(chatId: number, active: ActiveTurn): void {
    active.stopRequested = true;
    active.turn.interrupt().catch((error: unknown) => {
      this.deps.logger.error({ err: error, chatId }, 'interrupt failed; aborting the agent process');
      if (this.running.get(chatId) === active) active.turn.abort();
    });
  }

  private startGraceAbort(chatId: number, active: ActiveTurn): void {
    if (active.graceTimer) return;
    active.graceTimer = setTimeout(() => {
      if (this.running.get(chatId) !== active) return;
      active.turn.abort();
      const seconds = Math.round(this.stopGraceMs / 1000);
      void this.notify(() =>
        this.deps.notifier.sendNotice(chatId, `⚠️ Không dừng được sau ${seconds} giây — đã huỷ tiến trình.`),
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
