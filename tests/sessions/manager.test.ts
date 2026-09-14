import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner, RunningTurn, TurnEvent, TurnInput, TurnOutcome, TurnRequest } from '../../src/claude/runner.js';
import { QUEUE_CAP, SessionManager, type Notifier } from '../../src/sessions/manager.js';
import { StateStore } from '../../src/sessions/store.js';

class FakeTurn implements RunningTurn {
  interrupted = false;
  aborted = false;
  interruptResult: Promise<void> = Promise.resolve();
  readonly done: Promise<TurnOutcome>;
  private resolveDone: (outcome: TurnOutcome) => void = () => undefined;
  private rejectDone: (error: Error) => void = () => undefined;

  constructor(
    readonly request: TurnRequest,
    readonly emit: (event: TurnEvent) => void,
  ) {
    this.done = new Promise<TurnOutcome>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  interrupt(): Promise<void> {
    this.interrupted = true;
    return this.interruptResult;
  }

  abort(): void {
    this.aborted = true;
  }

  succeed(text = 'ok', costUsd = 0.1): void {
    this.resolveDone({ kind: 'success', text, costUsd });
  }

  fail(subtype: string, errors: string[]): void {
    this.resolveDone({ kind: 'error', subtype, errors, costUsd: 0.2 });
  }

  crash(error: Error): void {
    this.rejectDone(error);
  }
}

class FakeRunner implements Runner {
  turns: FakeTurn[] = [];
  startFailures = 0;
  nextInterruptResult: Promise<void> | null = null;

  start(request: TurnRequest, onEvent: (event: TurnEvent) => void): RunningTurn {
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new Error('spawn failed');
    }
    const turn = new FakeTurn(request, onEvent);
    if (this.nextInterruptResult) turn.interruptResult = this.nextInterruptResult;
    this.turns.push(turn);
    return turn;
  }

  turn(index: number): FakeTurn {
    const turn = this.turns[index];
    if (!turn) throw new Error(`no turn ${index}`);
    return turn;
  }
}

class FakeNotifier implements Notifier {
  markdown: string[] = [];
  notices: string[] = [];
  typing: boolean[] = [];

  sendMarkdown(_chatId: number, markdown: string): Promise<void> {
    this.markdown.push(markdown);
    return Promise.resolve();
  }

  sendNotice(_chatId: number, text: string): Promise<void> {
    this.notices.push(text);
    return Promise.resolve();
  }

  setTyping(_chatId: number, active: boolean): void {
    this.typing.push(active);
  }
}

const CHAT = 7;
const IDLE = 60 * 60 * 1000;
const text = (value: string): TurnInput => ({ kind: 'text', text: value });
const logger = pino({ level: 'silent' });

let clock: number;
let store: StateStore;
let runner: FakeRunner;
let notifier: FakeNotifier;
let broker: {
  hasPending: ReturnType<typeof vi.fn<(chatId: number) => boolean>>;
  cancelPending: ReturnType<typeof vi.fn<(chatId: number) => void>>;
};
let manager: SessionManager;

async function tick(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

let existingPaths: Set<string>;

function createManager(): SessionManager {
  return new SessionManager({
    store,
    runner,
    notifier,
    broker,
    idleTimeoutMs: IDLE,
    now: () => clock,
    logger,
    pathExists: (path) => Promise.resolve(existingPaths.has(path)),
    fallbackCwd: 'D:\\Projects',
  });
}

describe('project folder and start races', () => {
  it('falls back to the projects root when the project folder is gone', async () => {
    store.updateChat(CHAT, { cwd: 'D:\\Projects\\deleted', activeSessionId: 's-old' });
    await manager.submit(CHAT, text('hi'), 'hi');
    expect(notifier.notices).toEqual([
      '📁 Thư mục D:\\Projects\\deleted không còn tồn tại — đã chuyển về D:\\Projects và mở phiên mới.',
    ]);
    expect(runner.turn(0).request).toMatchObject({ cwd: 'D:\\Projects', resumeSessionId: null });
  });

  it('checks the folder again before running a queued input', async () => {
    existingPaths.add('D:\\Projects\\app');
    store.updateChat(CHAT, { cwd: 'D:\\Projects\\app' });
    await manager.submit(CHAT, text('one'), 'one');
    await manager.submit(CHAT, text('two'), 'two');
    existingPaths.delete('D:\\Projects\\app');

    runner.turn(0).succeed('first');
    await vi.waitFor(() => {
      expect(runner.turns).toHaveLength(2);
    });
    expect(runner.turn(1).request.cwd).toBe('D:\\Projects');
    expect(notifier.notices).toHaveLength(1);
  });

  it('queues a message that arrives while the previous one is still starting', async () => {
    const first = manager.submit(CHAT, text('one'), 'one');
    const second = manager.submit(CHAT, text('two'), 'two');
    await expect(first).resolves.toEqual({ kind: 'started' });
    await expect(second).resolves.toEqual({ kind: 'queued', position: 1 });
    expect(runner.turns).toHaveLength(1);
  });
});

beforeEach(async () => {
  clock = 1_000_000;
  const file = join(mkdtempSync(join(tmpdir(), 'pager-manager-')), 'state.json');
  store = (await StateStore.open(file, { cwd: 'D:\\Projects', model: null, effort: null }, () => clock)).store;
  runner = new FakeRunner();
  notifier = new FakeNotifier();
  broker = { hasPending: vi.fn(() => false), cancelPending: vi.fn() };
  existingPaths = new Set(['D:\\Projects', 'D:\\Projects\\trader']);
  manager = createManager();
});

afterEach(() => {
  vi.useRealTimers();
});

async function completeFirstSession(): Promise<void> {
  await manager.submit(CHAT, text('hello'), 'hello');
  runner.turn(0).emit({ type: 'session', sessionId: 's1' });
  runner.turn(0).succeed('answer');
  await tick();
}

describe('turns', () => {
  it('starts a new session and records it', async () => {
    expect(await manager.submit(CHAT, text('hi'), '  hello\n   world  ')).toEqual({ kind: 'started' });
    expect(runner.turn(0).request).toEqual({
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

    runner.turn(0).emit({ type: 'session', sessionId: 's1' });
    expect(store.getChat(CHAT).activeSessionId).toBe('s1');
    expect(store.findSession('s1')).toMatchObject({ chatId: CHAT, title: 'hello world', cwd: 'D:\\Projects' });

    runner.turn(0).succeed('answer', 0.42);
    await tick();
    expect(notifier.markdown).toEqual(['answer']);
    expect(notifier.typing).toEqual([true, false]);
    expect(manager.isBusy(CHAT)).toBe(false);
    expect(store.getChat(CHAT)).toMatchObject({ runningSince: null, lastTurnCostUsd: 0.42 });
  });

  it('resumes the active session on the next message', async () => {
    await completeFirstSession();
    await manager.submit(CHAT, text('again'), 'again');
    expect(runner.turn(1).request.resumeSessionId).toBe('s1');
    expect(store.findSession('s1')?.title).toBe('hello');
  });

  it('passes the chat model and effort', async () => {
    manager.setModel(CHAT, 'sonnet');
    manager.setEffort(CHAT, 'max');
    await manager.submit(CHAT, text('x'), 'x');
    expect(runner.turn(0).request).toMatchObject({ model: 'sonnet', effort: 'max' });
  });

  it('queues messages while running and runs them in order in the same session', async () => {
    await manager.submit(CHAT, text('one'), 'one');
    runner.turn(0).emit({ type: 'session', sessionId: 's1' });
    expect(await manager.submit(CHAT, text('two'), 'two')).toEqual({ kind: 'queued', position: 1 });
    expect(await manager.submit(CHAT, text('three'), 'three')).toEqual({ kind: 'queued', position: 2 });
    expect(runner.turns).toHaveLength(1);

    runner.turn(0).succeed('first');
    await tick();
    expect(runner.turns).toHaveLength(2);
    expect(runner.turn(1).request).toMatchObject({ resumeSessionId: 's1', input: text('two') });

    runner.turn(1).succeed('second');
    await tick();
    expect(runner.turn(2).request.input).toEqual(text('three'));
    runner.turn(2).succeed('third');
    await tick();
    expect(notifier.markdown).toEqual(['first', 'second', 'third']);
  });

  it('rejects messages beyond the queue cap', async () => {
    await manager.submit(CHAT, text('run'), 'run');
    for (let i = 0; i < QUEUE_CAP; i += 1) await manager.submit(CHAT, text(`q${i}`), 'q');
    expect(await manager.submit(CHAT, text('overflow'), 'overflow')).toEqual({ kind: 'queue_full' });
  });

  it('updates activity time on SDK events and tracks the current tool', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    clock += 5_000;
    runner.turn(0).emit({ type: 'tool', name: 'Bash' });
    runner.turn(0).emit({ type: 'activity' });
    expect(store.getChat(CHAT).lastActivityAt).toBe(clock);
    expect(manager.status(CHAT).currentTool).toBe('Bash');
  });

  it('reports error outcomes, empty results and crashes', async () => {
    await manager.submit(CHAT, text('a'), 'a');
    runner.turn(0).fail('error_max_turns', ['too many', 'again']);
    await tick();
    expect(notifier.notices).toEqual(['❌ error_max_turns: too many; again']);

    await manager.submit(CHAT, text('b'), 'b');
    runner.turn(1).succeed('   ');
    await tick();
    expect(notifier.markdown).toEqual(['✅ Xong (không có nội dung trả lời).']);

    await manager.submit(CHAT, text('c'), 'c');
    runner.turn(2).crash(new Error('boom'));
    await tick();
    expect(notifier.notices.at(-1)).toBe('❌ Lỗi: boom');
    expect(manager.isBusy(CHAT)).toBe(false);
    expect(store.getChat(CHAT).runningSince).toBeNull();
  });

  it('restores state when the runner throws while starting', async () => {
    runner.startFailures = 1;
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
    runner.startFailures = 1;
    runner.turn(0).succeed('first');
    await tick();
    expect(runner.turns).toHaveLength(2);
    expect(runner.turn(1).request.input).toEqual(text('three'));
    expect(notifier.notices).toEqual(['❌ Lỗi: spawn failed']);
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
    runner.turn(0).emit({ type: 'session', sessionId: 's1' });
    clock += IDLE * 3;
    await manager.checkIdle();
    expect(store.getChat(CHAT).activeSessionId).toBe('s1');

    runner.turn(0).succeed();
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
    expect(runner.turn(1).request.resumeSessionId).toBeNull();
    expect(notifier.notices[0]).toMatch(/^💤/);
  });

  it('reports remaining idle time in status', async () => {
    await completeFirstSession();
    clock += 10 * 60 * 1000;
    expect(manager.status(CHAT)).toEqual({
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
    });
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
    expect(runner.turn(0).interrupted).toBe(true);

    runner.turn(0).fail('error_during_execution', []);
    await tick();
    expect(notifier.notices).toEqual(['⏹ Đã dừng.']);
    expect(runner.turns).toHaveLength(1);
    expect(manager.isBusy(CHAT)).toBe(false);
  });

  it('aborts the process when the interrupt does not finish in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await manager.submit(CHAT, text('stuck'), 'stuck');
    manager.stop(CHAT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.turn(0).aborted).toBe(true);
    expect(notifier.notices).toEqual(['⚠️ Không dừng được sau 10 giây — đã huỷ tiến trình.']);

    runner.turn(0).crash(new Error('aborted'));
    await tick();
    expect(notifier.notices.at(-1)).toBe('⏹ Đã dừng.');
  });

  it('returns immediately and still aborts when interrupt never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    runner.nextInterruptResult = new Promise<void>(() => undefined);
    await manager.submit(CHAT, text('hung'), 'hung');
    expect(manager.stop(CHAT)).toEqual({ kind: 'stopping', dropped: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.turn(0).aborted).toBe(true);
  });

  it('aborts at once when interrupt fails', async () => {
    runner.nextInterruptResult = Promise.reject(new Error('transport closed'));
    await manager.submit(CHAT, text('x'), 'x');
    manager.stop(CHAT);
    await tick();
    expect(runner.turn(0).aborted).toBe(true);
  });

  it('does not abort when the turn ends within the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await manager.submit(CHAT, text('quick'), 'quick');
    manager.stop(CHAT);
    runner.turn(0).succeed();
    await tick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.turn(0).aborted).toBe(false);
  });

  it('still delivers the answer when /stop arrives after the result', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    await manager.submit(CHAT, text('queued'), 'queued');
    runner.turn(0).emit({ type: 'result' });

    expect(manager.stop(CHAT)).toEqual({ kind: 'finishing', dropped: 1 });
    expect(runner.turn(0).interrupted).toBe(false);
    runner.turn(0).succeed('the answer');
    await tick();
    expect(notifier.markdown).toEqual(['the answer']);
    expect(notifier.notices).toEqual([]);
    expect(runner.turns).toHaveLength(1);
  });
});

describe('status and recovery', () => {
  it('shows running state with the tool and prompt flag', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    runner.turn(0).emit({ type: 'tool', name: 'Read' });
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

    // The user can continue the session right after the notice, even after a long outage.
    await restarted.submit(CHAT, text('continue'), 'continue');
    expect(runner.turn(0).request.resumeSessionId).toBe('s1');
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatch(/^⚠️ Bot vừa khởi động lại; lượt đang chạy từ .+ đã bị gián đoạn/);
  });

  it('interrupts running turns on shutdown', async () => {
    await manager.submit(CHAT, text('x'), 'x');
    const shutdown = manager.shutdown();
    await tick();
    expect(runner.turn(0).interrupted).toBe(true);
    runner.turn(0).succeed();
    await shutdown;
    expect(manager.isBusy(CHAT)).toBe(false);
  });

  it('does not hang shutdown when interrupt never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    runner.nextInterruptResult = new Promise<void>(() => undefined);
    await manager.submit(CHAT, text('x'), 'x');
    const shutdown = manager.shutdown();
    await vi.advanceTimersByTimeAsync(10_000);
    await shutdown;
    expect(runner.turn(0).aborted).toBe(true);
  });
});
