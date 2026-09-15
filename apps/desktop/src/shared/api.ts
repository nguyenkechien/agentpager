/** Contract between the main process, the preload bridge and the renderer. Types and constants only. */

export type ApiErrorCode =
  | 'invalid_input'
  | 'invalid_config'
  | 'missing_config'
  | 'config_exists'
  | 'not_running'
  | 'timeout'
  | 'unauthorized'
  | 'fatal'
  | 'network'
  | 'invalid_token'
  | 'failed';

export const SETTINGS_FIELDS = [
  'botToken',
  'projectsRoot',
  'idleTimeoutMinutes',
  'logLevel',
  'agent.provider',
  'agent.executable',
  'agent.defaultModel',
  'agent.defaultEffort',
  'allowedUsers',
  'form',
] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];
export type FieldErrors = Partial<Record<SettingsField, string[]>>;

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  fieldErrors?: FieldErrors;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export const LOG_LEVEL_NAMES = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

export type BadgeState = 'running' | 'starting' | 'restarting' | 'stopped' | 'error' | 'unresponsive' | 'disconnected';

export interface LauncherView {
  kind: 'cli' | 'app';
  executable: string;
}

export interface DaemonView {
  badge: BadgeState;
  pid: number | null;
  startedAt: string | null;
  workerPid: number | null;
  restarts: number;
  botUsername: string | null;
  provider: string | null;
  lastError: string | null;
  launcher: LauncherView | null;
}

export interface AutostartView {
  enabled: boolean;
  /** The registered command and its arguments, when it could be read. */
  command: string[] | null;
  /** The registration runs this app's executable (not the npm CLI or another copy). */
  ownedByThisApp: boolean;
  problems: string[];
}

export interface UserView {
  username: string;
  paired: boolean;
  pairedAt: string | null;
}

export interface AgentSettingsView {
  provider: string;
  executable: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
}

export interface SettingsView {
  botTokenMasked: string;
  projectsRoot: string;
  idleTimeoutMinutes: number;
  logLevel: LogLevelName;
  agent: AgentSettingsView;
}

/** Best-effort values read from a config file that does not validate. */
export interface SettingsDraft {
  botTokenMasked: string | null;
  projectsRoot: string | null;
  idleTimeoutMinutes: number | null;
  logLevel: string | null;
  agent: { provider: string | null; executable: string | null; defaultModel: string | null; defaultEffort: string | null };
}

export type ConfigView =
  | { state: 'missing'; path: string }
  | { state: 'valid'; path: string; settings: SettingsView; users: UserView[] }
  | { state: 'invalid'; path: string; issues: string[]; fieldErrors: FieldErrors; draft: SettingsDraft | null; users: UserView[] };

/** Only the fields the user changed; the bot token only when a new one was typed. */
export interface SettingsPatch {
  botToken?: string;
  projectsRoot?: string;
  idleTimeoutMinutes?: number;
  logLevel?: LogLevelName;
  agent?: Partial<AgentSettingsView>;
}

export interface WizardInput {
  botToken: string;
  usernames: string[];
  projectsRoot: string;
  agent: { provider: string; executable: string | null };
  idleTimeoutMinutes: number;
}

export interface WizardDefaults {
  projectsRoot: string;
}

export type ReloadOutcome = { kind: 'reloaded' } | { kind: 'not_running' } | { kind: 'unchanged' } | { kind: 'failed'; message: string };

export interface UsersChange {
  users: UserView[];
  reload: ReloadOutcome;
}

export interface ProviderView {
  id: string;
  displayName: string;
  models: { id: string; label: string }[];
  efforts: string[];
}

export interface AgentDetectionView {
  executable: string | null;
  version: string | null;
  problems: string[];
}

export interface AppInfo {
  /** AGENTPAGER_HOME when set; machine-wide settings (autostart, login item) are off in that mode. */
  homeOverride: string | null;
}

export type LogSource = 'worker' | 'supervisor';

export interface LogLine {
  /** Epoch milliseconds; null for lines that are not pino JSON. */
  time: number | null;
  level: Exclude<LogLevelName, 'silent'> | null;
  message: string;
  extra: Record<string, unknown> | null;
}

/** What the updater is doing. `ready` exists on Windows (downloaded, installs itself), `available` on macOS. */
export type UpdateView =
  | { kind: 'disabled'; currentVersion: string; reason: 'development' | 'home_override' }
  | { kind: 'idle'; currentVersion: string; checkedAt: string | null }
  | { kind: 'checking'; currentVersion: string; checkedAt: string | null }
  | { kind: 'downloading'; currentVersion: string; version: string; percent: number }
  | { kind: 'ready'; currentVersion: string; version: string; notes: string | null; installError: string | null }
  | { kind: 'available'; currentVersion: string; version: string; downloadUrl: string; checkedAt: string }
  | { kind: 'waiting_idle'; currentVersion: string; version: string; activeTurns: number; queuedInputs: number }
  | { kind: 'installing'; currentVersion: string; version: string }
  | { kind: 'error'; currentVersion: string; message: string; checkedAt: string | null };

/** `ask` stops for a busy agent; `when_idle` waits for it; `now` stops the running turn. */
export type InstallMode = 'ask' | 'when_idle' | 'now';

export type InstallResult =
  | { kind: 'installing' }
  | { kind: 'waiting' }
  | { kind: 'busy'; activeTurns: number; queuedInputs: number }
  | { kind: 'busy_unknown' }
  | { kind: 'opened' };

/** Plain functions (no `this`), so they can be passed around and spied on freely. */
export interface AgentpagerApi {
  config: {
    load: () => Promise<ApiResult<ConfigView>>;
    save: (patch: SettingsPatch) => Promise<ApiResult<ConfigView>>;
    runWizard: (input: WizardInput, overwrite: boolean) => Promise<ApiResult<ConfigView>>;
    verifyToken: (token: string) => Promise<ApiResult<{ username: string }>>;
    defaults: () => Promise<ApiResult<WizardDefaults>>;
  };
  users: {
    add: (username: string) => Promise<ApiResult<UsersChange>>;
    remove: (username: string) => Promise<ApiResult<UsersChange>>;
    unpair: (username: string) => Promise<ApiResult<UsersChange>>;
  };
  daemon: {
    status: () => Promise<ApiResult<DaemonView>>;
    start: () => Promise<ApiResult<DaemonView>>;
    stop: () => Promise<ApiResult<DaemonView>>;
    restart: () => Promise<ApiResult<DaemonView>>;
  };
  autostart: {
    get: () => Promise<ApiResult<AutostartView>>;
    set: (enabled: boolean) => Promise<ApiResult<AutostartView>>;
  };
  /** "Hiện icon khay khi đăng nhập": the app itself (tray only) at login. */
  loginItem: {
    get: () => Promise<ApiResult<boolean>>;
    set: (enabled: boolean) => Promise<ApiResult<boolean>>;
  };
  agent: {
    providers: () => Promise<ApiResult<ProviderView[]>>;
    detect: (provider: string, executable: string | null) => Promise<ApiResult<AgentDetectionView>>;
  };
  dialog: {
    pickFolder: (defaultPath: string | null) => Promise<ApiResult<string | null>>;
    pickExecutable: (defaultPath: string | null) => Promise<ApiResult<string | null>>;
  };
  shell: {
    openLogFolder: () => Promise<ApiResult<null>>;
    openConfigFile: () => Promise<ApiResult<null>>;
  };
  app: {
    info: () => Promise<ApiResult<AppInfo>>;
  };
  onStatus: (listener: (view: DaemonView) => void) => () => void;
  onConfigChanged: (listener: () => void) => () => void;
  logs: {
    subscribe: (source: LogSource, onLines: (lines: LogLine[]) => void) => () => void;
  };
}
