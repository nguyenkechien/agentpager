import type { StopResult } from '@chiennguyen/agentpager/control';
import type { DaemonInfo, SupervisorStatus } from '@chiennguyen/agentpager/daemon';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../../../src/main/services/results.js';
import type { SourceEvent, UpdateSource } from '../../../src/main/update/source.js';
import { UpdateService, type UpdateServiceDeps } from '../../../src/main/update/updateService.js';
import type { UpdateView } from '../../../src/shared/api.js';

const NOW = new Date('2026-09-15T10:00:00.000Z');
const EXE = 'C:\\Programs\\agentpager\\agentpager.exe';

class FakeSource {
  checks = 0;
  installs = 0;
  private listener: ((event: SourceEvent) => void) | null = null;
  private finishCheck: (() => void) | null = null;

  constructor(readonly kind: 'windows' | 'mac') {}

  asSource(): UpdateSource {
    const onEvent = (listener: (event: SourceEvent) => void): void => {
      this.listener = listener;
    };
    const check = (): Promise<void> => {
      this.checks += 1;
      return new Promise((resolve) => {
        this.finishCheck = resolve;
      });
    };
    if (this.kind === 'mac') return { kind: 'mac', onEvent, check };
    return {
      kind: 'windows',
      onEvent,
      check,
      install: () => {
        this.installs += 1;
      },
    };
  }

  emit(event: SourceEvent): void {
    this.listener?.(event);
  }

  done(): void {
    this.finishCheck?.();
  }
}

function status(activeTurns: number | null, queuedInputs: number | null = 0): SupervisorStatus {
  return {
    pid: 42,
    startedAt: '2026-09-15T08:00:00.000Z',
    workerPid: 43,
    workerState: 'running',
    restarts: 0,
    botUsername: 'test_bot',
    provider: 'claude-code',
    lastError: null,
    activeTurns,
    queuedInputs,
  };
}

function info(kind: 'app' | 'cli'): DaemonInfo {
  return { pid: 42, startedAt: '2026-09-15T08:00:00.000Z', ipc: { path: 'pipe' }, token: 'a'.repeat(64), launcher: { kind, executable: kind === 'app' ? EXE : 'main.js' } };
}

interface Harness {
  service: UpdateService;
  source: FakeSource;
  events: string[];
  views: UpdateView[];
  daemon: { info: DaemonInfo | null; status: SupervisorStatus | null };
  stopResult: StopResult;
}

function harness(options: { kind?: 'windows' | 'mac' | null; disabledReason?: 'development' | 'home_override' } = {}): Harness {
  const source = new FakeSource(options.kind ?? 'windows');
  const h: Omit<Harness, 'service'> = {
    source,
    events: [],
    views: [],
    daemon: { info: null, status: null },
    stopResult: { kind: 'stopped' },
  };
  const deps: UpdateServiceDeps = {
    source: options.kind === null ? null : source.asSource(),
    disabledReason: options.disabledReason ?? 'development',
    currentVersion: '0.1.0',
    readDaemon: () => Promise.resolve(h.daemon),
    ownsDaemon: (daemonInfo) => daemonInfo?.launcher?.kind === 'app',
    stopDaemon: () => {
      h.events.push('stop');
      return Promise.resolve(h.stopResult);
    },
    writeMarker: () => {
      h.events.push('marker');
      return Promise.resolve();
    },
    openExternal: (url) => {
      h.events.push(`open ${url}`);
      return Promise.resolve();
    },
    now: () => NOW,
    log: { info: () => undefined, error: () => undefined },
  };
  const service = new UpdateService(deps);
  service.onChange((view) => {
    h.views.push(view);
  });
  return Object.assign(h, { service });
}

async function readyHarness(): Promise<Harness> {
  const h = harness();
  const checking = h.service.check();
  h.source.emit({ kind: 'checking' });
  h.source.emit({ kind: 'downloading', version: '0.1.1', percent: 0 });
  h.source.emit({ kind: 'ready', version: '0.1.1', notes: 'Bug fixes' });
  h.source.done();
  await checking;
  return h;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('UpdateService states', () => {
  it('is disabled without a source and never checks', async () => {
    const h = harness({ kind: null, disabledReason: 'home_override' });
    expect(h.service.view()).toEqual({ kind: 'disabled', currentVersion: '0.1.0', reason: 'home_override' });
    await expect(h.service.check()).resolves.toMatchObject({ kind: 'disabled' });
    await expect(h.service.install('now')).rejects.toBeInstanceOf(ApiFailure);
    expect(h.source.checks).toBe(0);
  });

  it('maps a check without an update to idle with the time', async () => {
    const h = harness();
    expect(h.service.view()).toEqual({ kind: 'idle', currentVersion: '0.1.0', checkedAt: null });
    const checking = h.service.check();
    h.source.emit({ kind: 'checking' });
    h.source.emit({ kind: 'none' });
    h.source.done();
    await expect(checking).resolves.toEqual({ kind: 'idle', currentVersion: '0.1.0', checkedAt: NOW.toISOString() });
    expect(h.views.map((view) => view.kind)).toEqual(['checking', 'idle']);
  });

  it('shares a check in progress', async () => {
    const h = harness();
    const first = h.service.check();
    const second = h.service.check();
    expect(h.source.checks).toBe(1);
    h.source.emit({ kind: 'none' });
    h.source.done();
    await Promise.all([first, second]);
  });

  it('shows download progress, then the ready update, and stops checking', async () => {
    const h = await readyHarness();
    expect(h.views.map((view) => view.kind)).toEqual(['checking', 'downloading', 'ready']);
    expect(h.service.view()).toEqual({ kind: 'ready', currentVersion: '0.1.0', version: '0.1.1', notes: 'Bug fixes', installError: null });
    await h.service.check();
    expect(h.source.checks).toBe(1);
  });

  it('keeps the last check time on errors', async () => {
    const h = harness();
    const first = h.service.check();
    h.source.emit({ kind: 'none' });
    h.source.done();
    await first;
    const second = h.service.check();
    h.source.emit({ kind: 'error', message: 'offline' });
    h.source.done();
    await expect(second).resolves.toEqual({ kind: 'error', currentVersion: '0.1.0', message: 'offline', checkedAt: NOW.toISOString() });
  });
});

describe('UpdateService.install on Windows', () => {
  it('refuses when nothing is downloaded', async () => {
    const h = harness();
    await expect(h.service.install('ask')).rejects.toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('installs right away when no bot runs, telling the shell first', async () => {
    const h = await readyHarness();
    h.service.onBeforeInstall(() => {
      h.events.push(`before install (installs so far: ${String(h.source.installs)})`);
    });
    await expect(h.service.install('ask')).resolves.toEqual({ kind: 'installing' });
    expect(h.events).toEqual(['before install (installs so far: 0)']);
    expect(h.source.installs).toBe(1);
    expect(h.service.view()).toMatchObject({ kind: 'installing', version: '0.1.1' });
  });

  it('stops its own idle bot after leaving the resume marker, then installs', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(0) };
    await expect(h.service.install('ask')).resolves.toEqual({ kind: 'installing' });
    expect(h.events).toEqual(['marker', 'stop']);
    expect(h.source.installs).toBe(1);
  });

  it('does not stop a bot started by the cli', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('cli'), status: status(3) };
    await expect(h.service.install('ask')).resolves.toEqual({ kind: 'installing' });
    expect(h.events).toEqual([]);
  });

  it('asks first when the agent runs turns or has queued messages', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(1, 2) };
    await expect(h.service.install('ask')).resolves.toEqual({ kind: 'busy', activeTurns: 1, queuedInputs: 2 });
    h.daemon = { info: info('app'), status: status(0, 2) };
    await expect(h.service.install('ask')).resolves.toEqual({ kind: 'busy', activeTurns: 0, queuedInputs: 2 });
    expect(h.service.view().kind).toBe('ready');
    expect(h.source.installs).toBe(0);
  });

  it('cannot tell whether an old core is busy', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(null, null) };
    await expect(h.service.install('ask')).resolves.toEqual({ kind: 'busy_unknown' });
    await expect(h.service.install('when_idle')).rejects.toMatchObject({ error: { code: 'invalid_input' } });
    await expect(h.service.install('now')).resolves.toEqual({ kind: 'installing' });
    expect(h.events).toEqual(['marker', 'stop']);
  });

  it('installs now even while busy', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(2) };
    await expect(h.service.install('now')).resolves.toEqual({ kind: 'installing' });
    expect(h.events).toEqual(['marker', 'stop']);
  });

  it('waits until the agent is idle, following the counts', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(2, 1) };
    await expect(h.service.install('when_idle')).resolves.toEqual({ kind: 'waiting' });
    expect(h.service.view()).toMatchObject({ kind: 'waiting_idle', activeTurns: 2, queuedInputs: 1 });

    h.daemon = { info: info('app'), status: status(1, 0) };
    h.service.onDaemonStatus();
    await flush();
    expect(h.service.view()).toMatchObject({ kind: 'waiting_idle', activeTurns: 1, queuedInputs: 0 });
    expect(h.source.installs).toBe(0);

    h.daemon = { info: info('app'), status: status(0, 0) };
    h.service.onDaemonStatus();
    await flush();
    expect(h.events).toEqual(['marker', 'stop']);
    expect(h.source.installs).toBe(1);
  });

  it('installs a waiting update when the bot stopped on its own', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(1) };
    await h.service.install('when_idle');
    h.daemon = { info: null, status: null };
    h.service.onDaemonStatus();
    await flush();
    expect(h.events).toEqual([]);
    expect(h.source.installs).toBe(1);
  });

  it('cancels waiting', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(1) };
    await h.service.install('when_idle');
    expect(h.service.cancelWaiting()).toMatchObject({ kind: 'ready', version: '0.1.1' });
    h.daemon = { info: info('app'), status: status(0) };
    h.service.onDaemonStatus();
    await flush();
    expect(h.source.installs).toBe(0);
  });

  it('does not install when the bot does not stop, and shows why', async () => {
    const h = await readyHarness();
    h.daemon = { info: info('app'), status: status(0) };
    h.stopResult = { kind: 'timeout' };
    await expect(h.service.install('ask')).rejects.toMatchObject({ error: { code: 'timeout' } });
    expect(h.source.installs).toBe(0);
    expect(h.service.view()).toMatchObject({ kind: 'ready', installError: 'The bot did not stop within 25 seconds, so the update was not installed.' });
  });
});

describe('UpdateService on macOS', () => {
  it('opens the download page of an available release', async () => {
    const h = harness({ kind: 'mac' });
    const checking = h.service.check();
    h.source.emit({ kind: 'available', version: '0.1.1', downloadUrl: 'https://github.com/nguyenkechien/agentpager/releases/download/v0.1.1/agentpager-0.1.1-arm64.dmg' });
    h.source.done();
    await checking;
    expect(h.service.view()).toMatchObject({ kind: 'available', version: '0.1.1', checkedAt: NOW.toISOString() });
    await expect(h.service.install('ask')).resolves.toEqual({ kind: 'opened' });
    expect(h.events).toEqual(['open https://github.com/nguyenkechien/agentpager/releases/download/v0.1.1/agentpager-0.1.1-arm64.dmg']);
    // A later check can still find an even newer release.
    const again = h.service.check();
    expect(h.source.checks).toBe(2);
    h.source.done();
    await again;
  });

  it('refuses to open anything outside the repository', async () => {
    const h = harness({ kind: 'mac' });
    h.source.emit({ kind: 'available', version: '0.1.1', downloadUrl: 'https://evil.example/agentpager.dmg' });
    await expect(h.service.openDownload()).rejects.toMatchObject({ error: { code: 'invalid_input' } });
    expect(h.events).toEqual([]);
  });
});
