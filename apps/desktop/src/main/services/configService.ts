import { posix, win32 } from 'node:path';
import {
  ConfigError,
  isValidBotToken,
  maskToken,
  normalizeUsername,
  validateConfig,
  type AgentpagerConfig,
  type AllowedUser,
  type ConfigStore,
} from '@chiennguyen/agentpager/config';
import type { UsersChangedResult } from '@chiennguyen/agentpager/control';
import type { ProviderCatalogEntry } from '@chiennguyen/agentpager/providers';
import type {
  ConfigView,
  FieldErrors,
  ReloadOutcome,
  SettingsDraft,
  SettingsPatch,
  SettingsView,
  UsersChange,
  UserView,
  WizardDefaults,
  WizardInput,
} from '../../shared/api.js';
import { ApiFailure, fieldErrorsFromIssues, isMissingConfig } from './results.js';

export type TokenCheck = { kind: 'valid'; username: string } | { kind: 'invalid'; message: string } | { kind: 'network'; message: string };

export interface ConfigServiceDeps {
  store: Pick<ConfigStore, 'filePath' | 'exists' | 'read' | 'write' | 'update'>;
  catalog: readonly ProviderCatalogEntry[];
  /** Null when the file does not exist. */
  readText: (path: string) => Promise<string | null>;
  pathExists: (path: string) => Promise<boolean>;
  /** Telegram getMe, classified: a rejected token and an unreachable Telegram need different answers. */
  checkToken: (token: string) => Promise<TokenCheck>;
  notifyUsersChanged: () => Promise<UsersChangedResult>;
  platform: NodeJS.Platform;
  homedir: string;
}

export const TOKEN_FORMAT_MESSAGE = 'Token không đúng định dạng <số>:<chuỗi> của BotFather.';
export const UNPARSEABLE_CONFIG_MESSAGE = 'File cấu hình không phải JSON hợp lệ — mở file để sửa hoặc chạy lại wizard.';
export const LAST_USER_MESSAGE = 'Không thể xoá người dùng cuối cùng — bot cần ít nhất 1 người dùng.';
const WIZARD_LOG_LEVEL = 'info';

type JsonObject = Record<string, unknown>;

function objectOrEmpty(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

function userView(user: AllowedUser): UserView {
  return { username: user.username, paired: user.userId !== null, pairedAt: user.pairedAt };
}

function settingsView(config: AgentpagerConfig): SettingsView {
  return {
    botTokenMasked: maskToken(config.telegram.botToken),
    projectsRoot: config.projectsRoot,
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    logLevel: config.logLevel,
    agent: { ...config.agent },
  };
}

function parseJson(text: string | null): { value: unknown } | null {
  if (text === null) return null;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    // An unparseable file has no draft to offer; the caller reports the core's issue instead.
    return null;
  }
}

function draftFromRaw(raw: unknown): { draft: SettingsDraft; users: UserView[] } {
  const root = objectOrEmpty(raw);
  const agent = objectOrEmpty(root.agent);
  const token = stringOrNull(objectOrEmpty(root.telegram).botToken);
  const users = Array.isArray(root.allowedUsers)
    ? root.allowedUsers.flatMap((entry): UserView[] => {
        const user = objectOrEmpty(entry);
        const username = stringOrNull(user.username);
        return username === null ? [] : [{ username, paired: typeof user.userId === 'number', pairedAt: stringOrNull(user.pairedAt) }];
      })
    : [];
  return {
    draft: {
      botTokenMasked: token === null ? null : maskToken(token),
      projectsRoot: stringOrNull(root.projectsRoot),
      idleTimeoutMinutes: typeof root.idleTimeoutMinutes === 'number' ? root.idleTimeoutMinutes : null,
      logLevel: stringOrNull(root.logLevel),
      agent: {
        provider: stringOrNull(agent.provider),
        executable: stringOrNull(agent.executable),
        defaultModel: stringOrNull(agent.defaultModel),
        defaultEffort: stringOrNull(agent.defaultEffort),
      },
    },
    users,
  };
}

/** Works on raw JSON too, so an invalid file can be repaired by a save. */
function applyPatch(base: unknown, patch: SettingsPatch): unknown {
  const root = objectOrEmpty(base);
  const next: JsonObject = { ...root };
  if (patch.botToken !== undefined) next.telegram = { ...objectOrEmpty(root.telegram), botToken: patch.botToken };
  if (patch.projectsRoot !== undefined) next.projectsRoot = patch.projectsRoot;
  if (patch.idleTimeoutMinutes !== undefined) next.idleTimeoutMinutes = patch.idleTimeoutMinutes;
  if (patch.logLevel !== undefined) next.logLevel = patch.logLevel;
  if (patch.agent !== undefined) next.agent = { ...objectOrEmpty(root.agent), ...patch.agent };
  return next;
}

function invalidInput(message: string, fieldErrors?: FieldErrors): ApiFailure {
  return new ApiFailure({ code: 'invalid_input', message, ...(fieldErrors && { fieldErrors }) });
}

function throwIfAny(errors: FieldErrors): void {
  const messages = Object.values(errors).flat();
  if (messages.length > 0) throw invalidInput(messages.join('\n'), errors);
}

export class ConfigService {
  constructor(private readonly deps: ConfigServiceDeps) {}

  get path(): string {
    return this.deps.store.filePath;
  }

  async load(): Promise<ConfigView> {
    const path = this.path;
    if (!(await this.deps.store.exists())) return { state: 'missing', path };
    try {
      const config = await this.deps.store.read();
      return { state: 'valid', path, settings: settingsView(config), users: config.allowedUsers.map(userView) };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      // The file can disappear between exists() and read().
      if (isMissingConfig(error)) return { state: 'missing', path };
      const raw = parseJson(await this.deps.readText(path));
      const best = raw === null ? null : draftFromRaw(raw.value);
      return {
        state: 'invalid',
        path,
        issues: error.issues,
        fieldErrors: fieldErrorsFromIssues(error.issues),
        draft: best?.draft ?? null,
        users: best?.users ?? [],
      };
    }
  }

  async save(patch: SettingsPatch): Promise<ConfigView> {
    throwIfAny(await this.pathErrors(patch));
    if (await this.isValidOnDisk()) {
      await this.deps.store.update((current) => validateConfig(applyPatch(current, patch), this.deps.catalog));
    } else {
      const raw = parseJson(await this.deps.readText(this.path));
      if (raw === null) throw new ApiFailure({ code: 'invalid_config', message: UNPARSEABLE_CONFIG_MESSAGE });
      await this.deps.store.write(validateConfig(applyPatch(raw.value, patch), this.deps.catalog));
    }
    return this.load();
  }

  async runWizard(input: WizardInput, overwrite: boolean): Promise<ConfigView> {
    if (!overwrite && (await this.deps.store.exists())) {
      throw new ApiFailure({ code: 'config_exists', message: `Đã có cấu hình tại ${this.path}.` });
    }
    const errors = await this.pathErrors({ botToken: input.botToken, projectsRoot: input.projectsRoot, agent: { executable: input.agent.executable } });
    const usernames: string[] = [];
    if (input.usernames.length === 0) errors.allowedUsers = ['Cần ít nhất 1 username.'];
    for (const entry of input.usernames) {
      try {
        const username = normalizeUsername(entry);
        if (!usernames.includes(username)) usernames.push(username);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        (errors.allowedUsers ??= []).push(...error.issues);
      }
    }
    throwIfAny(errors);

    const config = validateConfig(
      {
        version: 1,
        telegram: { botToken: input.botToken },
        allowedUsers: usernames.map((username) => ({ username, userId: null, pairedAt: null })),
        projectsRoot: input.projectsRoot,
        idleTimeoutMinutes: input.idleTimeoutMinutes,
        logLevel: WIZARD_LOG_LEVEL,
        agent: { provider: input.agent.provider, executable: input.agent.executable, defaultModel: null, defaultEffort: null },
      },
      this.deps.catalog,
    );
    await this.deps.store.write(config);
    return this.load();
  }

  async verifyToken(token: string): Promise<{ username: string }> {
    const trimmed = token.trim();
    if (!isValidBotToken(trimmed)) throw new ApiFailure({ code: 'invalid_token', message: TOKEN_FORMAT_MESSAGE });
    const result = await this.deps.checkToken(trimmed);
    switch (result.kind) {
      case 'valid':
        return { username: result.username };
      case 'invalid':
        throw new ApiFailure({ code: 'invalid_token', message: `Token không hợp lệ: ${result.message}` });
      case 'network':
        throw new ApiFailure({ code: 'network', message: `Không kết nối được Telegram: ${result.message}` });
    }
  }

  async defaults(): Promise<WizardDefaults> {
    const { platform, homedir } = this.deps;
    const candidate = platform === 'win32' ? 'D:\\Projects' : posix.join(homedir, 'Projects');
    return { projectsRoot: (await this.deps.pathExists(candidate)) ? candidate : homedir };
  }

  async addUser(input: string): Promise<UsersChange> {
    const username = this.username(input);
    const next = await this.deps.store.update((config) => {
      if (config.allowedUsers.some((user) => user.username === username)) throw invalidInput(`@${username} đã có trong danh sách.`);
      return { ...config, allowedUsers: [...config.allowedUsers, { username, userId: null, pairedAt: null }] };
    });
    return this.usersChanged(next);
  }

  async removeUser(input: string): Promise<UsersChange> {
    const username = this.username(input);
    const next = await this.deps.store.update((config) => {
      this.requireUser(config, username);
      if (config.allowedUsers.length === 1) throw invalidInput(LAST_USER_MESSAGE);
      return { ...config, allowedUsers: config.allowedUsers.filter((user) => user.username !== username) };
    });
    return this.usersChanged(next);
  }

  async unpairUser(input: string): Promise<UsersChange> {
    const username = this.username(input);
    const outcome = { changed: false };
    const next = await this.deps.store.update((config) => {
      const entry = this.requireUser(config, username);
      if (entry.userId === null) return config;
      outcome.changed = true;
      return {
        ...config,
        allowedUsers: config.allowedUsers.map((user) => (user === entry ? { ...user, userId: null, pairedAt: null } : user)),
      };
    });
    if (!outcome.changed) return { users: next.allowedUsers.map(userView), reload: { kind: 'unchanged' } };
    return this.usersChanged(next);
  }

  /** Folders and files must exist; relative paths are left to the core's validation message. */
  private async pathErrors(patch: SettingsPatch): Promise<FieldErrors> {
    const errors: FieldErrors = {};
    if (patch.botToken !== undefined && !isValidBotToken(patch.botToken)) errors.botToken = [TOKEN_FORMAT_MESSAGE];
    const { projectsRoot } = patch;
    if (projectsRoot !== undefined && isAbsolutePath(projectsRoot) && !(await this.deps.pathExists(projectsRoot))) {
      errors.projectsRoot = [`Không tìm thấy thư mục: ${projectsRoot}`];
    }
    const executable = patch.agent?.executable;
    if (typeof executable === 'string' && isAbsolutePath(executable) && !(await this.deps.pathExists(executable))) {
      errors['agent.executable'] = [`Không tìm thấy file: ${executable}`];
    }
    return errors;
  }

  /** A missing file is not created by a settings save: that is the wizard's job. */
  private async isValidOnDisk(): Promise<boolean> {
    try {
      await this.deps.store.read();
      return true;
    } catch (error) {
      if (error instanceof ConfigError && !isMissingConfig(error)) return false;
      throw error;
    }
  }

  private username(input: string): string {
    try {
      return normalizeUsername(input);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      throw invalidInput(error.issues.join('\n'), { allowedUsers: error.issues });
    }
  }

  private requireUser(config: AgentpagerConfig, username: string): AllowedUser {
    const entry = config.allowedUsers.find((user) => user.username === username);
    if (!entry) throw invalidInput(`Không có @${username} trong danh sách.`);
    return entry;
  }

  private async usersChanged(config: AgentpagerConfig): Promise<UsersChange> {
    const result = await this.deps.notifyUsersChanged();
    const reload: ReloadOutcome = result.kind === 'failed' ? { kind: 'failed', message: result.message } : { kind: result.kind };
    return { users: config.allowedUsers.map(userView), reload };
  }
}
