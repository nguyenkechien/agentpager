import { vi } from 'vitest';
import type {
  AgentpagerApi,
  ApiError,
  ApiErrorCode,
  ApiResult,
  AppInfo,
  AutostartView,
  ConfigView,
  DaemonView,
  FieldErrors,
  LogLine,
  LogSource,
  ProviderView,
  SettingsView,
  UpdateView,
  UsersChange,
  UserView,
} from '../../src/shared/api.js';

export const IDLE_UPDATE: UpdateView = { kind: 'idle', currentVersion: '0.1.0', checkedAt: null };

export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function fail(code: ApiErrorCode, message: string, fieldErrors?: FieldErrors): { ok: false; error: ApiError } {
  return { ok: false, error: { code, message, ...(fieldErrors && { fieldErrors }) } };
}

export function daemonView(overrides: Partial<DaemonView> = {}): DaemonView {
  return {
    badge: 'stopped',
    pid: null,
    startedAt: null,
    workerPid: null,
    restarts: 0,
    botUsername: null,
    provider: null,
    lastError: null,
    launcher: null,
    ...overrides,
  };
}

export function runningView(overrides: Partial<DaemonView> = {}): DaemonView {
  return daemonView({
    badge: 'running',
    pid: 4242,
    startedAt: new Date(Date.now() - 2 * 3_600_000 - 5 * 60_000).toISOString(),
    workerPid: 5000,
    botUsername: 'test_bot',
    provider: 'claude-code',
    launcher: { kind: 'app', executable: 'C:\\agentpager\\agentpager.exe' },
    ...overrides,
  });
}

export function settings(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    botTokenMasked: '123456…vwx',
    projectsRoot: 'D:\\Projects',
    idleTimeoutMinutes: 60,
    logLevel: 'info',
    agent: { provider: 'claude-code', executable: null, defaultModel: null, defaultEffort: null },
    ...overrides,
  };
}

export function user(username: string, pairedAt: string | null = null): UserView {
  return { username, paired: pairedAt !== null, pairedAt };
}

export function validConfig(overrides: { settings?: Partial<SettingsView>; users?: UserView[] } = {}): ConfigView {
  return {
    state: 'valid',
    path: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\config.json',
    settings: settings(overrides.settings),
    users: overrides.users ?? [user('alice_one', '2026-09-14T09:00:00.000Z'), user('bob_two')],
  };
}

export const PROVIDER: ProviderView = {
  id: 'claude-code',
  displayName: 'Claude Code',
  models: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
  efforts: ['low', 'medium', 'high'],
};

export const AUTOSTART_OFF: AutostartView = { enabled: false, command: null, ownedByThisApp: false, problems: [] };

export interface FakeLogSubscription {
  source: LogSource;
  onLines: (lines: LogLine[]) => void;
  active: boolean;
}

export interface FakeApi {
  api: AgentpagerApi;
  emitStatus: (view: DaemonView) => void;
  emitConfigChanged: () => void;
  emitUpdate: (view: UpdateView) => void;
  logSubscriptions: FakeLogSubscription[];
}

/** A complete bridge with harmless defaults, installed as `window.agentpager`; tests replace single methods. */
export function installFakeApi(): FakeApi {
  const statusListeners = new Set<(view: DaemonView) => void>();
  const configListeners = new Set<() => void>();
  const updateListeners = new Set<(view: UpdateView) => void>();
  const logSubscriptions: FakeLogSubscription[] = [];
  const usersChange = (users: UserView[]): Promise<ApiResult<UsersChange>> => Promise.resolve(ok({ users, reload: { kind: 'reloaded' } }));
  const api: AgentpagerApi = {
    config: {
      load: vi.fn(() => Promise.resolve(ok(validConfig()))),
      save: vi.fn(() => Promise.resolve(ok(validConfig()))),
      runWizard: vi.fn(() => Promise.resolve(ok(validConfig({ users: [user('alice_one')] })))),
      verifyToken: vi.fn(() => Promise.resolve(ok({ username: 'test_bot' }))),
      defaults: vi.fn(() => Promise.resolve(ok({ projectsRoot: 'D:\\Projects' }))),
    },
    users: {
      add: vi.fn(() => usersChange([])),
      remove: vi.fn(() => usersChange([])),
      unpair: vi.fn(() => usersChange([])),
    },
    daemon: {
      status: vi.fn(() => Promise.resolve(ok(daemonView()))),
      start: vi.fn(() => Promise.resolve(ok(runningView()))),
      stop: vi.fn(() => Promise.resolve(ok(daemonView()))),
      restart: vi.fn(() => Promise.resolve(ok(runningView()))),
      switchToApp: vi.fn(() => Promise.resolve(ok(runningView()))),
    },
    autostart: {
      get: vi.fn(() => Promise.resolve(ok(AUTOSTART_OFF))),
      set: vi.fn((enabled: boolean) =>
        Promise.resolve(ok({ enabled, command: enabled ? ['C:\\agentpager\\agentpager.exe', '--daemon'] : null, ownedByThisApp: enabled, problems: [] })),
      ),
    },
    loginItem: {
      get: vi.fn(() => Promise.resolve(ok(false))),
      set: vi.fn((enabled: boolean) => Promise.resolve(ok(enabled))),
    },
    agent: {
      providers: vi.fn(() => Promise.resolve(ok([PROVIDER]))),
      detect: vi.fn((_provider: string, executable: string | null) =>
        Promise.resolve(ok({ executable: executable ?? 'C:\\tools\\claude.exe', version: '2.1.0 (Claude Code)', problems: [] })),
      ),
    },
    dialog: {
      pickFolder: vi.fn(() => Promise.resolve(ok<string | null>(null))),
      pickExecutable: vi.fn(() => Promise.resolve(ok<string | null>(null))),
    },
    shell: {
      openLogFolder: vi.fn(() => Promise.resolve(ok(null))),
      openConfigFile: vi.fn(() => Promise.resolve(ok(null))),
    },
    app: {
      info: vi.fn(() => Promise.resolve(ok<AppInfo>({ homeOverride: null, platform: 'win32', version: '0.1.0' }))),
      uninstall: vi.fn(() => Promise.resolve(ok(null))),
    },
    update: {
      get: vi.fn(() => Promise.resolve(ok(IDLE_UPDATE))),
      check: vi.fn(() => Promise.resolve(ok<UpdateView>({ kind: 'idle', currentVersion: '0.1.0', checkedAt: '2026-09-15T10:00:00.000Z' }))),
      install: vi.fn(() => Promise.resolve(ok({ kind: 'installing' as const }))),
      cancelWaiting: vi.fn(() => Promise.resolve(ok(IDLE_UPDATE))),
      openDownload: vi.fn(() => Promise.resolve(ok({ kind: 'opened' as const }))),
    },
    onUpdate: (listener) => {
      updateListeners.add(listener);
      return () => {
        updateListeners.delete(listener);
      };
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onConfigChanged: (listener) => {
      configListeners.add(listener);
      return () => {
        configListeners.delete(listener);
      };
    },
    logs: {
      subscribe: (source, onLines) => {
        const subscription: FakeLogSubscription = { source, onLines, active: true };
        logSubscriptions.push(subscription);
        return () => {
          subscription.active = false;
        };
      },
    },
  };
  window.agentpager = api;
  return {
    api,
    emitStatus: (view) => {
      for (const listener of statusListeners) listener(view);
    },
    emitConfigChanged: () => {
      for (const listener of configListeners) listener();
    },
    emitUpdate: (view) => {
      for (const listener of updateListeners) listener(view);
    },
    logSubscriptions,
  };
}
