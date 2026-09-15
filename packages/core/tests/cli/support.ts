import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../../src/cli/io.js';
import type { CliDeps } from '../../src/cli/types.js';
import type { AgentpagerConfig } from '../../src/core/config/schema.js';
import { ConfigStore } from '../../src/core/config/store.js';
import { IpcError, type IpcCommand } from '../../src/daemon/ipc.js';
import type { SupervisorStatus } from '../../src/daemon/supervisor.js';
import type { AutostartStatus, AutostartTarget } from '../../src/platform/autostart/types.js';
import { appPaths } from '../../src/platform/paths.js';
import type { Detection, ProviderCatalogEntry } from '../../src/providers/types.js';
import { createFakeProvider } from '../support/fakeProvider.js';

export const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwx';

export class FakeIo implements CliIo {
  outs: string[] = [];
  errs: string[] = [];
  asked: { question: string; hidden: boolean }[] = [];
  confirmed: string[] = [];

  constructor(
    private readonly answers: string[] = [],
    private readonly confirms: boolean[] = [],
  ) {}

  out = (line: string): void => {
    this.outs.push(line);
  };

  err = (line: string): void => {
    this.errs.push(line);
  };

  ask = (question: string, options: { hidden?: boolean; defaultValue?: string } = {}): Promise<string> => {
    this.asked.push({ question, hidden: options.hidden === true });
    const answer = this.answers.shift();
    if (answer === undefined) return Promise.reject(new Error(`unexpected question: ${question}`));
    return Promise.resolve(answer === '' && options.defaultValue !== undefined ? options.defaultValue : answer);
  };

  confirm = (question: string): Promise<boolean> => {
    this.confirmed.push(question);
    const answer = this.confirms.shift();
    if (answer === undefined) return Promise.reject(new Error(`unexpected confirmation: ${question}`));
    return Promise.resolve(answer);
  };
}

export function runningStatus(overrides: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    pid: 4242,
    startedAt: '2026-09-14T08:00:00.000Z',
    workerPid: 5000,
    workerState: 'running',
    restarts: 0,
    botUsername: 'test_bot',
    provider: 'fake',
    lastError: null,
    activeTurns: 0,
    queuedInputs: 0,
    ...overrides,
  };
}

export interface TestState {
  daemon: SupervisorStatus | null;
  ipcCalls: IpcCommand[];
  spawned: number;
  onSpawn: () => void;
  fatal: string | null;
  foregroundRuns: boolean[];
  autostartCalls: string[];
  autostartStatus: AutostartStatus | Error;
  invalidTokens: Set<string>;
  logLines: string[];
  tailRequests: number[];
  followedLines: string[];
  followStopped: boolean;
  existing: Set<string>;
  clock: number;
}

export interface TestCli {
  deps: CliDeps;
  state: TestState;
  store: ConfigStore;
}

export const DETECTED: Detection = { executable: 'C:\\tools\\claude.exe', version: '2.1.0 (Claude Code)', problems: [] };

export function createTestCli(options: { platform?: NodeJS.Platform; detection?: Detection } = {}): TestCli {
  const home = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  const paths = appPaths({ platform: process.platform, env: { AGENTPAGER_HOME: home }, homedir: home, username: 'alex' });
  const platformName = options.platform ?? 'win32';
  const homedir = platformName === 'win32' ? 'C:\\Users\\alex' : '/Users/alex';
  const fake = createFakeProvider().provider;
  const entry: ProviderCatalogEntry = {
    id: fake.id,
    displayName: fake.displayName,
    capabilities: fake.capabilities,
    models: fake.models,
    efforts: fake.efforts,
    detect: () => Promise.resolve(options.detection ?? DETECTED),
  };
  const catalog = [entry];
  const store = new ConfigStore(paths.config, { platform: process.platform, catalog });

  const state: TestState = {
    daemon: null,
    ipcCalls: [],
    spawned: 0,
    onSpawn: () => undefined,
    fatal: null,
    foregroundRuns: [],
    autostartCalls: [],
    autostartStatus: { enabled: false, target: null, problems: [] },
    invalidTokens: new Set(),
    logLines: [],
    tailRequests: [],
    followedLines: [],
    followStopped: false,
    existing: new Set(),
    clock: 1_000_000,
  };

  const describeTarget = (target: AutostartTarget): string =>
    `${target.command}|${target.args.join(' ')}|${target.workingDir}|${String(target.console)}`;

  const deps: CliDeps = {
    paths,
    platform: { platform: platformName, env: {}, homedir, username: 'alex' },
    packageRoot: home,
    cliPath: 'C:\\npm\\node_modules\\agentpager\\dist\\cli\\main.js',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    version: '0.1.0',
    configStore: store,
    catalog,
    autostart: {
      enable: (target) => {
        state.autostartCalls.push(`enable:${describeTarget(target)}`);
        return Promise.resolve(['Đã bật tự khởi động agentpager.']);
      },
      disable: () => {
        state.autostartCalls.push('disable');
        return Promise.resolve(['Đã tắt tự khởi động agentpager.']);
      },
      status: () =>
        state.autostartStatus instanceof Error ? Promise.reject(state.autostartStatus) : Promise.resolve(state.autostartStatus),
    },
    ipc: (command) => {
      state.ipcCalls.push(command);
      const daemon = state.daemon;
      if (!daemon) return Promise.reject(new IpcError('not_running', 'agentpager không chạy'));
      switch (command) {
        case 'status':
          return Promise.resolve(daemon);
        case 'stop':
          state.daemon = null;
          return Promise.resolve({ stopping: true });
        case 'restart':
          state.daemon = { ...daemon, workerPid: (daemon.workerPid ?? 0) + 1, restarts: daemon.restarts + 1 };
          return Promise.resolve({ restarting: true });
        case 'reload-users':
          return Promise.resolve({ reloaded: true });
        case 'ping':
          return Promise.resolve({ version: '0.1.0' });
      }
    },
    spawnDaemon: () => {
      state.spawned += 1;
      state.onSpawn();
    },
    runDaemon: (foreground) => {
      state.foregroundRuns.push(foreground);
      return Promise.resolve(0);
    },
    telegram: {
      getMe: (token) =>
        state.invalidTokens.has(token) ? Promise.reject(new Error('401: Unauthorized')) : Promise.resolve({ username: 'test_bot' }),
    },
    sleep: (ms) => {
      state.clock += ms;
      return Promise.resolve();
    },
    now: () => state.clock,
    readLogTail: (lines) => {
      state.tailRequests.push(lines);
      return Promise.resolve(state.logLines.slice(-lines));
    },
    followLog: (onLine) => {
      for (const line of state.followedLines) onLine(line);
      return Promise.resolve(() => {
        state.followStopped = true;
      });
    },
    waitForInterrupt: () => Promise.resolve(),
    lastDaemonFatal: () => Promise.resolve(state.fatal),
    exists: (path) => Promise.resolve(state.existing.has(path)),
  };
  return { deps, state, store };
}

export function validConfig(overrides: Partial<AgentpagerConfig> = {}): AgentpagerConfig {
  return {
    version: 1,
    telegram: { botToken: TOKEN },
    allowedUsers: [
      { username: 'alice_one', userId: 111, pairedAt: '2026-09-14T08:00:00.000Z' },
      { username: 'bob_two', userId: null, pairedAt: null },
    ],
    projectsRoot: 'D:\\Projects',
    idleTimeoutMinutes: 60,
    logLevel: 'info',
    agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
    ...overrides,
  };
}
