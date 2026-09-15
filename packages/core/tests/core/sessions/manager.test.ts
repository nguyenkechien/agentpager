import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitTracker } from '../../../src/core/sessions/limits.js';
import { QUEUE_CAP, SessionManager, type Notifier, type SessionActivity } from '../../../src/core/sessions/manager.js';
import { StateStore } from '../../../src/core/sessions/store.js';
import type { LimitSnapshot, TurnInput, UsageReport } from '../../../src/providers/types.js';
import { createFakeProvider, type FakeProviderHandle } from '../../support/fakeProvider.js';

class FakeNotifier implements Notifier {
  markdown: string[] = [];
  notices: string[] = [];
  typing: boolean[] = [];
  /** Every sent message in order, to check that limit notices come before results. */
  sent: string[] = [];

  sendMarkdown(_chatId: number, markdown: string): Promise<void> {
    this.markdown.push(markdown);
    this.sent.push(markdown);
    return Promise.resolve();
  }

  sendNotice(_chatId: number, text: string): Promise<void> {
    this.notices.push(text);
    this.sent.push(text);
    return Promise.resolve();
  }

  setTyping(_chatId: number, active: boolean): void {
    this.typing.push(active);
  }
}

const CHAT = 7;
const IDLE = 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const text = (value: string): TurnInput => ({ kind: 'text', text: value });
const logger = pino({ level: 'silent' });

let clock: number;
let store: StateStore;
let fake: FakeProviderHandle;
let notifier: FakeNotifier;
let broker: {
  hasPending: ReturnType<typeof vi.fn<(chatId: number) => boolean>>;
  cancelPending: ReturnType<typeof vi.fn<(chatId: number) => void>>;
};
let usageReport: UsageReport;
let limits: LimitTracker;
let existingPaths: Set<string>;
let manager: SessionManager;

async function tick(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function createManager(handle: FakeProviderHandle = fake, onActivity?: (activity: SessionActivity) => void): SessionManager {
  return new SessionManager({
    store,
    provider: handle.provider,
    notifier,
    broker,
    limits,
    idleTimeoutMs: IDLE,
    now: () => clock,
    logger,
    pathExists: (path) => Promise.resolve(existingPaths.has(path)),
    fallbackCwd: 'D:\\Projects',
    onActivity,
  });
}

function rejected(overrides: Partial<LimitSnapshot>): LimitSnapshot {
  return {
    status: 'rejected',
    windowKey: 'five_hour',
    windowLabel: '5 giờ',
    scope: 'global',
    resetsAtMs: clock + HOUR,
    utilizationPercent: 100,
    threshold: null,
    ...overrides,
  };
}

beforeEach(async () => {
  clock = 1_000_000;
  const file = join(mkdtempSync(join(tmpdir(), 'pager-manager-')), 'state.json');
  store = (await StateStore.open(file, { cwd: 'D:\\Projects', model: null, effort: null }, () => clock)).store;
  fake = createFakeProvider();
  notifier = new FakeNotifier();
  broker = { hasPending: vi.fn(() => false), cancelPending: vi.fn() };
  usageReport = { subscription: 'max', available: true, extraUsageEnabled: false, windows: [] };
  limits = new LimitTracker({
    store,
    notifier,
    fetchUsage: () => Promise.resolve(usageReport),
    now: () => clock,
    logger,
  });
  existingPaths = new Set(['D:\\Projects', 'D:\\Projects\\trader']);
  manager = createManager();
});

afterEach(() => {
  limits.dispose();
  vi.useRealTimers();
});

async function completeFirstSession(): Promise<void> {
  await manager.submit(CHAT, text('hello'), 'hello');
  fake.turn(0).emit({ type: 'session', sessionId: 's1' });
  fake.turn(0).succeed('answer');
  await tick();
}

describe('turns', () => {
  it('starts a new session and records it', async () => {
    expect(await manager.submit(CHAT, text('hi'), '  hello\n   world  ')).toEqual({ kind: 'started' });
    expect(fake.turn(0).request).toEqual({
      chatId: CHAT,
      cwd: 'D:\\Projects',
      resumeSessionId: null,
      model: null,
      effort: null,
      input: text('hi'),
    });
    expect(manager.isBusy(CHAT)).toBe(true);
    expect(store.getChat(CHAT).runningSince).toBe(clock);
    expect(notifier.typing).toEqual([true]);

    fake.turn(0).emit({ type: 'session', sessionId: 's1' });
    expect(store.getChat(CHAT).activeSessionId).toBe('s1');
    expect(store.findSession('s1')).toMatchObject({ chatId: CHAT, title: 'hello world', cwd: 'D:\\Projects' });

    fake.turn(0).succeed('answer', 0.42);
    await tick();
    expect(notifier.markdown).toEqual(['answer']);
    expect(notifier.typing).toEqual([true, false]);
    expect(manager.isBusy(CHAT)).toBe(false);
    expect(store.getChat(CHAT)).toMatchObject({ runningSince: null, lastTurnCostUsd: 0.42 });
  });

  it('keeps the previous cost when the provider reports none', async () => {
    await completeFirstSession();
    await manager.submit(CHAT, text('again'), 'again');
    fake.turn(1).succeed('free', null);
    await tick();
    expect(store.getChat(CHAT).lastTurnCostUsd).toBe(0.1);
  });

  it('resumes the active session on the next message', async () => {
    await completeFirstSession();
    await manager.submit(CHAT, text('again'), 'again');
    expect(fake.turn(1).request.resumeSessionId).toBe('s1');
    expect(store.findSession('s1')?.title).toBe('hello');
  });

  it('passes the chat model and effort the provider offers', async () => {
    manager.setModel(CHAT, 'smart');
    manager.setEffort(CHAT, 'high');
    await manager.submit(CHAT, text('x'), 'x');
    expect(fake.turn(0).request).toMatchObject({ model: 'smart', effort: 'high' });
  });

  it('falls back to defaults for a model or effort the provider does not offer', async () => {
    manager.setModel(CHAT, 'opus');
    manager.setEffort(CHAT, 'max');
    await manager.submit(CHAT, text('x'), 'x');
    expect(fake.turn(0).request).toMatchObject({ model: null, effort: null });
    expect(manager.status(CHAT)).toMatchObject({ model: null, effort: null });
    expect(store.getChat(CHAT)).toMatchObject({ model: 'opus', effort: 'max' });
  });

  it('queues messages while running and runs them in order in the same session', async () => {
    await manager.submit(CHAT, text('one'), 'one');
    fake.turn(0).emit({ type: 'session', sessionId: 's1' });
    expect(await manager.submit(CHAT, text('two'), 'two')).toEqual({ kind: 'queued', position: 1 });
    expect(await manager.submit(CHAT, text('three'), 'three')).toEqual({ kind: 'queued', position: 2 });
    expect(fake.turns).toHaveLength(1);

    fake.turn(0).succeed('first');
    await tick();
    expect(fake.turns).toHaveLength(2);
    expect(fake.turn(1).request).toMatchObject({ resumeSessionId: 's1', input: text('two') });

    fake.turn(1).succeed('second');
    await tick();
    expect(fake.turn(2).request.input).toEqual(text('three'));
    fake.turn(2).succeed('third');
    await tick();
    expect(notifier.markdown).toEqual(['first', 'second', 'third']);
  });

  it('rejects messages beyond the queue cap', async () => {
    await manager.submit(CHAT, text('run'), 'run');
    for (let i = 0; i < QUEUE_CAP; i += 1) await manager.submit(CHAT, text(`q${i}`), 'q');
    expect(await manager.submit(CHAT, text('overflow'), 'overflow')).toEqual({ kind: 'queue_full' });
  });

  it('updates activity time on agent events and tracks the current tool', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    clock += 5_000;
    fake.turn(0).emit({ type: 'tool', name: 'Bash' });
    fake.turn(0).emit({ type: 'activity' });
    expect(store.getChat(CHAT).lastActivityAt).toBe(clock);
    expect(manager.status(CHAT).currentTool).toBe('Bash');
  });

  it('reports error outcomes, empty results and crashes', async () => {
    await manager.submit(CHAT, text('a'), 'a');
    fake.turn(0).fail('error_max_turns', ['too many', 'again']);
    await tick();
    expect(notifier.notices).toEqual(['❌ error_max_turns: too many; again']);

    await manager.submit(CHAT, text('b'), 'b');
    fake.turn(1).succeed('   ');
    await tick();
    expect(notifier.markdown).toEqual(['✅ Xong (không có nội dung trả lời).']);

    await manager.submit(CHAT, text('c'), 'c');
    fake.turn(2).crash(new Error('boom'));
    await tick();
    expect(notifier.notices.at(-1)).toBe('❌ Lỗi: boom');
    expect(manager.isBusy(CHAT)).toBe(false);
    expect(store.getChat(CHAT).runningSince).toBeNull();
  });

  it('restores state when the provider throws while starting', async () => {
    fake.startFailures.count = 1;
    expect(await manager.submit(CHAT, text('x'), 'x')).toEqual({ kind: 'started' });
    await tick();
    expect(manager.isBusy(CHAT)).toBe(false);
    expect(notifier.typing).toEqual([true, false]);
    expect(store.getChat(CHAT).runningSince).toBeNull();
    expect(notifier.notices).toEqual(['❌ Lỗi: spawn failed']);
  });

  it('skips a queued input whose turn fails to start and runs the next one', async () => {
    await manager.submit(CHAT, text('one'), 'one');
    await manager.submit(CHAT, text('two'), 'two');
    await manager.submit(CHAT, text('three'), 'three');
    fake.startFailures.count = 1;
    fake.turn(0).succeed('first');
    await vi.waitFor(() => {
      expect(fake.turns).toHaveLength(2);
    });
    expect(fake.turn(1).request.input).toEqual(text('three'));
    expect(notifier.notices).toEqual(['❌ Lỗi: spawn failed']);
  });
});

describe('project folder and start races', () => {
  it('falls back to the projects root when the project folder is gone', async () => {
    store.updateChat(CHAT, { cwd: 'D:\\Projects\\deleted', activeSessionId: 's-old' });
    await manager.submit(CHAT, text('hi'), 'hi');
    expect(notifier.notices).toEqual([
      '📁 Thư mục D:\\Projects\\deleted không còn tồn tại — đã chuyển về D:\\Projects và mở phiên mới.',
    ]);
    expect(fake.turn(0).request).toMatchObject({ cwd: 'D:\\Projects', resumeSessionId: null });
  });

  it('checks the folder again before running a queued input', async () => {
    existingPaths.add('D:\\Projects\\app');
    store.updateChat(CHAT, { cwd: 'D:\\Projects\\app' });
    await manager.submit(CHAT, text('one'), 'one');
    await manager.submit(CHAT, text('two'), 'two');
    existingPaths.delete('D:\\Projects\\app');

    fake.turn(0).succeed('first');
    await vi.waitFor(() => {
      expect(fake.turns).toHaveLength(2);
    });
    expect(fake.turn(1).request.cwd).toBe('D:\\Projects');
    expect(notifier.notices).toHaveLength(1);
  });

  it('queues a message that arrives while the previous one is still starting', async () => {
    const first = manager.submit(CHAT, text('one'), 'one');
    const second = manager.submit(CHAT, text('two'), 'two');
    await expect(first).resolves.toEqual({ kind: 'started' });
    await expect(second).resolves.toEqual({ kind: 'queued', position: 1 });
    expect(fake.turns).toHaveLength(1);
  });
});

describe('plan limits', () => {
  it('announces the limit before the result, drops the queue and blocks new messages', async () => {
    await manager.submit(CHAT, text('one'), 'one');
    await manager.submit(CHAT, text('queued'), 'queued');
    fake.turn(0).emit({ type: 'rate_limit', snapshot: rejected({}) });
    fake.turn(0).emit({ type: 'limit_error' });
    fake.turn(0).fail('error_during_execution', ["You've hit your limit"]);
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(3);
    });

    expect(notifier.sent[0]).toMatch(/^⛔ Đã hết limit 5 giờ · reset lúc .+ \(còn 1 giờ\)\. Session vẫn giữ/);
    expect(notifier.sent.slice(1)).toEqual([
      '🗑 Đã huỷ 1 tin trong hàng đợi vì hết limit.',
      "❌ error_during_execution: You've hit your limit",
    ]);
    expect(fake.turns).toHaveLength(1);

    expect(await manager.submit(CHAT, text('later'), 'later')).toEqual({
      kind: 'limit_blocked',
      label: '5 giờ',
      resetsAtMs: clock + HOUR,
    });
    expect(manager.status(CHAT).limitBlock).toEqual({ label: '5 giờ', resetsAtMs: clock + HOUR });
    expect(fake.turns).toHaveLength(1);
  });

  it('looks up usage when only a limit error was seen', async () => {
    usageReport = {
      ...usageReport,
      windows: [{ key: 'seven_day', label: '7 ngày', scope: 'global', utilizationPercent: 100, resetsAtMs: clock + 24 * HOUR }],
    };
    await manager.submit(CHAT, text('x'), 'x');
    fake.turn(0).emit({ type: 'limit_error' });
    fake.turn(0).succeed("You've hit your weekly limit");
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(2);
    });
    expect(notifier.sent[0]).toMatch(/^⛔ Đã hết limit 7 ngày/);
    expect(notifier.sent[1]).toBe("You've hit your weekly limit");
    expect(manager.status(CHAT).limitBlock).toMatchObject({ label: '7 ngày' });
  });

  it('keeps the queue for model-scoped limits', async () => {
    await manager.submit(CHAT, text('one'), 'one');
    await manager.submit(CHAT, text('two'), 'two');
    fake.turn(0).emit({
      type: 'rate_limit',
      snapshot: rejected({ windowKey: 'seven_day_opus', windowLabel: '7 ngày · Opus', scope: 'model' }),
    });
    fake.turn(0).succeed('done');
    await vi.waitFor(() => {
      expect(fake.turns).toHaveLength(2);
    });
    expect(notifier.notices[0]).toMatch(/^⛔ Đã hết limit 7 ngày · Opus .+ Dùng \/model/);
  });

  it('clears a stale block after a successful turn', async () => {
    store.updateChat(CHAT, { limitBlock: { limitType: 'five_hour', label: '5 giờ', resetsAtMs: clock - 1 } });
    await manager.submit(CHAT, text('x'), 'x');
    fake.turn(0).succeed('fine');
    await tick();
    expect(store.getChat(CHAT).limitBlock).toBeNull();
  });

  it('forwards API retry notices before the result', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    fake.turn(0).emit({ type: 'api_retry', attempt: 1, maxRetries: 10, delayMs: 4_000, error: 'overloaded' });
    fake.turn(0).succeed('recovered');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(2);
    });
    expect(notifier.sent).toEqual(['⏳ API đang quá tải — đang thử lại (lần 1/10, sau 4 giây)', 'recovered']);
  });
});

describe('idle expiry', () => {
  it('expires an idle session', async () => {
    await completeFirstSession();
    clock += IDLE + 1;
    await manager.checkIdle();
    expect(store.getChat(CHAT).activeSessionId).toBeNull();
    expect(notifier.notices).toEqual([
      '💤 Phiên đã kết thúc sau 60 phút không hoạt động. Tin nhắn tiếp theo sẽ mở phiên mới. /resume để quay lại.',
    ]);
  });

  it('does not expire before the timeout', async () => {
    await completeFirstSession();
    clock += IDLE - 1;
    await manager.checkIdle();
    expect(store.getChat(CHAT).activeSessionId).toBe('s1');
  });

  it('never expires a running turn or a pending prompt', async () => {
    await manager.submit(CHAT, text('long'), 'long');
    fake.turn(0).emit({ type: 'session', sessionId: 's1' });
    clock += IDLE * 3;
    await manager.checkIdle();
    expect(store.getChat(CHAT).activeSessionId).toBe('s1');

    fake.turn(0).succeed();
    await tick();
    broker.hasPending.mockReturnValue(true);
    clock += IDLE * 3;
    await manager.checkIdle();
    expect(store.getChat(CHAT).activeSessionId).toBe('s1');
    expect(notifier.notices).toEqual([]);
  });

  it('expires on submit when the timer has not ticked yet', async () => {
    await completeFirstSession();
    clock += IDLE + 1;
    await manager.submit(CHAT, text('later'), 'later');
    expect(fake.turn(1).request.resumeSessionId).toBeNull();
    expect(notifier.notices[0]).toMatch(/^💤/);
  });

  it('reports remaining idle time and the agent in status', async () => {
    await completeFirstSession();
    clock += 10 * 60 * 1000;
    expect(manager.status(CHAT)).toEqual({
      agent: 'Fake Agent',
      guardSupported: true,
      cwd: 'D:\\Projects',
      sessionId: 's1',
      runningSinceMs: null,
      currentTool: null,
      waitingForUser: false,
      queueLength: 0,
      idleRemainingMs: 50 * 60 * 1000,
      model: null,
      effort: null,
      lastTurnCostUsd: 0.1,
      limitBlock: null,
    });
  });

  it('reports a provider without a command guard', () => {
    const unguarded = createManager(createFakeProvider({ commandGuard: false }));
    expect(unguarded.status(CHAT).guardSupported).toBe(false);
  });
});

describe('session commands', () => {
  it('refuses session changes while busy', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    expect(manager.newSession(CHAT)).toBe('busy');
    expect(manager.setProject(CHAT, 'D:\\Projects\\other')).toBe('busy');
    expect(manager.resume(CHAT, { sessionId: 's9', cwd: 'D:\\Projects', title: 't' })).toBe('busy');
  });

  it('starts a fresh session with /new', async () => {
    await completeFirstSession();
    expect(manager.newSession(CHAT)).toBe('ok');
    expect(store.getChat(CHAT).activeSessionId).toBeNull();
  });

  it('switches project and ends the session only when it changes', async () => {
    await completeFirstSession();
    expect(manager.setProject(CHAT, 'D:\\Projects')).toBe('unchanged');
    expect(store.getChat(CHAT).activeSessionId).toBe('s1');
    expect(manager.setProject(CHAT, 'D:\\Projects\\trader')).toBe('ok');
    expect(store.getChat(CHAT)).toMatchObject({ cwd: 'D:\\Projects\\trader', activeSessionId: null });
  });

  it('resumes a session into its project', () => {
    clock += 500;
    expect(manager.resume(CHAT, { sessionId: 's9', cwd: 'D:\\Projects\\trader', title: 'old work' })).toBe('ok');
    expect(store.getChat(CHAT)).toMatchObject({ activeSessionId: 's9', cwd: 'D:\\Projects\\trader', lastActivityAt: clock });
    expect(store.findSession('s9')).toMatchObject({ title: 'old work', lastActiveAt: clock });
  });
});

describe('stop', () => {
  it('reports idle when nothing runs', () => {
    expect(manager.stop(CHAT)).toEqual({ kind: 'idle' });
  });

  it('interrupts the turn, cancels prompts and drops the queue', async () => {
    await manager.submit(CHAT, text('run'), 'run');
    await manager.submit(CHAT, text('q1'), 'q1');
    await manager.submit(CHAT, text('q2'), 'q2');

    expect(manager.stop(CHAT)).toEqual({ kind: 'stopping', dropped: 2 });
    expect(broker.cancelPending).toHaveBeenCalledWith(CHAT);
    expect(fake.turn(0).interrupted).toBe(true);

    fake.turn(0).fail('error_during_execution', []);
    await tick();
    expect(notifier.notices).toEqual(['⏹ Đã dừng.']);
    expect(fake.turns).toHaveLength(1);
    expect(manager.isBusy(CHAT)).toBe(false);
  });

  it('aborts the process when the interrupt does not finish in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await manager.submit(CHAT, text('stuck'), 'stuck');
    manager.stop(CHAT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.turn(0).aborted).toBe(true);
    expect(notifier.notices).toEqual(['⚠️ Không dừng được sau 10 giây — đã huỷ tiến trình.']);

    fake.turn(0).crash(new Error('aborted'));
    await tick();
    expect(notifier.notices.at(-1)).toBe('⏹ Đã dừng.');
  });

  it('returns immediately and still aborts when interrupt never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await manager.submit(CHAT, text('hung'), 'hung');
    fake.turn(0).interruptResult = new Promise<void>(() => undefined);
    expect(manager.stop(CHAT)).toEqual({ kind: 'stopping', dropped: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.turn(0).aborted).toBe(true);
  });

  it('aborts at once when interrupt fails', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    fake.turn(0).interruptResult = Promise.reject(new Error('transport closed'));
    manager.stop(CHAT);
    await tick();
    expect(fake.turn(0).aborted).toBe(true);
  });

  it('does not abort when the turn ends within the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await manager.submit(CHAT, text('quick'), 'quick');
    manager.stop(CHAT);
    fake.turn(0).succeed();
    await tick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.turn(0).aborted).toBe(false);
  });

  it('still delivers the answer when /stop arrives after the result', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    await manager.submit(CHAT, text('queued'), 'queued');
    fake.turn(0).emit({ type: 'result' });

    expect(manager.stop(CHAT)).toEqual({ kind: 'finishing', dropped: 1 });
    expect(fake.turn(0).interrupted).toBe(false);
    fake.turn(0).succeed('the answer');
    await tick();
    expect(notifier.markdown).toEqual(['the answer']);
    expect(notifier.notices).toEqual([]);
    expect(fake.turns).toHaveLength(1);
  });

  it('kills the process right away for providers without a native interrupt', async () => {
    const killed = createFakeProvider({ interrupt: 'kill' });
    const killManager = createManager(killed);
    await killManager.submit(CHAT, text('x'), 'x');

    expect(killManager.stop(CHAT)).toEqual({ kind: 'stopping', dropped: 0 });
    expect(killed.turn(0).aborted).toBe(true);
    expect(killed.turn(0).interrupted).toBe(false);

    killed.turn(0).crash(new Error('killed'));
    await tick();
    expect(notifier.notices).toEqual(['⏹ Đã dừng.']);
  });
});

describe('status and recovery', () => {
  it('shows running state with the tool and prompt flag', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    fake.turn(0).emit({ type: 'tool', name: 'Read' });
    broker.hasPending.mockReturnValue(true);
    expect(manager.status(CHAT)).toMatchObject({
      runningSinceMs: clock,
      currentTool: 'Read',
      waitingForUser: true,
      idleRemainingMs: null,
    });
  });

  it('notifies about a turn interrupted by a restart', async () => {
    store.updateChat(CHAT, { runningSince: 5, lastActivityAt: 5, activeSessionId: 's1' });
    clock += IDLE * 5;
    const restarted = createManager();
    await restarted.recoverAfterRestart();
    expect(store.getChat(CHAT)).toMatchObject({ runningSince: null, activeSessionId: 's1', lastActivityAt: clock });
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatch(/^⚠️ Bot vừa khởi động lại; lượt đang chạy từ .+ đã bị gián đoạn/);

    // The user can continue the session right after the notice, even after a long outage.
    await restarted.submit(CHAT, text('continue'), 'continue');
    expect(fake.turn(0).request.resumeSessionId).toBe('s1');
  });

  it('interrupts running turns on shutdown', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    const shutdown = manager.shutdown();
    await tick();
    expect(fake.turn(0).interrupted).toBe(true);
    fake.turn(0).succeed();
    await shutdown;
    expect(manager.isBusy(CHAT)).toBe(false);
  });

  it('does not hang shutdown when interrupt never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await manager.submit(CHAT, text('x'), 'x');
    fake.turn(0).interruptResult = new Promise<void>(() => undefined);
    const shutdown = manager.shutdown();
    await vi.advanceTimersByTimeAsync(10_000);
    await shutdown;
    expect(fake.turn(0).aborted).toBe(true);
  });

  it('kills running turns on shutdown for providers without a native interrupt', async () => {
    const killed = createFakeProvider({ interrupt: 'kill' });
    const killManager = createManager(killed);
    await killManager.submit(CHAT, text('x'), 'x');
    const shutdown = killManager.shutdown();
    await tick();
    expect(killed.turn(0).aborted).toBe(true);
    killed.turn(0).crash(new Error('killed'));
    await shutdown;
    expect(killManager.isBusy(CHAT)).toBe(false);
  });
});

describe('activity', () => {
  const idle: SessionActivity = { activeTurns: 0, queuedInputs: 0 };

  function tracked(): { reports: SessionActivity[]; manager: SessionManager } {
    const reports: SessionActivity[] = [];
    return {
      reports,
      manager: createManager(fake, (activity) => {
        reports.push(activity);
      }),
    };
  }

  it('counts running turns and queued inputs and reports each change once', async () => {
    const { reports, manager: tracking } = tracked();
    expect(tracking.activity()).toEqual(idle);

    await tracking.submit(CHAT, text('one'), 'one');
    expect(tracking.activity()).toEqual({ activeTurns: 1, queuedInputs: 0 });
    await tracking.submit(CHAT, text('two'), 'two');
    expect(tracking.activity()).toEqual({ activeTurns: 1, queuedInputs: 1 });

    fake.turn(0).succeed('first');
    await tick();
    expect(tracking.activity()).toEqual({ activeTurns: 1, queuedInputs: 0 });
    fake.turn(1).succeed('second');
    await tick();

    expect(tracking.activity()).toEqual(idle);
    expect(reports).toEqual([
      { activeTurns: 1, queuedInputs: 0 },
      { activeTurns: 1, queuedInputs: 1 },
      { activeTurns: 1, queuedInputs: 0 },
      idle,
    ]);
  });

  it('counts chats separately', async () => {
    const { manager: tracking } = tracked();
    await tracking.submit(CHAT, text('one'), 'one');
    await tracking.submit(CHAT + 1, text('other'), 'other');
    expect(tracking.activity()).toEqual({ activeTurns: 2, queuedInputs: 0 });
  });

  it('reports the dropped queue on /stop and idle once the turn ends', async () => {
    const { reports, manager: tracking } = tracked();
    await tracking.submit(CHAT, text('one'), 'one');
    await tracking.submit(CHAT, text('two'), 'two');
    tracking.stop(CHAT);
    expect(tracking.activity()).toEqual({ activeTurns: 1, queuedInputs: 0 });
    fake.turn(0).succeed('stopped');
    await tick();
    expect(reports.at(-1)).toEqual(idle);
  });

  it('goes back to idle when the provider cannot start the turn', async () => {
    fake.startFailures.count = 1;
    const { reports, manager: tracking } = tracked();
    await tracking.submit(CHAT, text('one'), 'one');
    expect(tracking.activity()).toEqual(idle);
    expect(reports).toEqual([{ activeTurns: 1, queuedInputs: 0 }, idle]);
  });

  it('clears the queue on shutdown', async () => {
    const { reports, manager: tracking } = tracked();
    await tracking.submit(CHAT, text('one'), 'one');
    await tracking.submit(CHAT, text('two'), 'two');
    const stopping = tracking.shutdown();
    expect(tracking.activity()).toEqual({ activeTurns: 1, queuedInputs: 0 });
    fake.turn(0).succeed('done');
    await stopping;
    expect(tracking.activity()).toEqual(idle);
    expect(reports.at(-1)).toEqual(idle);
  });
});
