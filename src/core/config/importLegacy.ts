import { resolve } from 'node:path';
import { ConfigError, LOG_LEVELS, normalizeUsername, type AgentpagerConfig, type AllowedUser, type LogLevel } from './schema.js';

export interface LegacyImport {
  config: Partial<AgentpagerConfig> & { allowedUsers: AllowedUser[] };
  /** The legacy chat state file, when present, so setup can copy sessions over. */
  stateFile: string | null;
  warnings: string[];
}

export interface LegacyImportDeps {
  /** Resolves null when the file does not exist. */
  readFile: (path: string) => Promise<string | null>;
  exists: (path: string) => Promise<boolean>;
  getChat: (userId: number) => Promise<{ username: string | null } | null>;
}

const LEGACY_PROVIDER = 'claude-code';

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '');
}

/** KEY=VALUE lines, `#` comments, blank lines and optional quotes (the subset the legacy `.env` used). */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    result[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1).trim());
  }
  return result;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveUser(userId: number, deps: LegacyImportDeps, warnings: string[]): Promise<AllowedUser> {
  const unresolved = (reason: string): AllowedUser => {
    warnings.push(`Không tìm được username của user ${userId} (${reason}) — giữ theo ID.`);
    return { username: null, userId, pairedAt: null };
  };
  let chat: { username: string | null } | null;
  try {
    chat = await deps.getChat(userId);
  } catch (error) {
    return unresolved(messageOf(error));
  }
  if (!chat?.username) return unresolved('không có username');
  try {
    return { username: normalizeUsername(chat.username), userId, pairedAt: null };
  } catch (error) {
    if (error instanceof ConfigError) return unresolved(error.issues.join('; '));
    throw error;
  }
}

async function importUsers(raw: string | undefined, deps: LegacyImportDeps, warnings: string[]): Promise<AllowedUser[]> {
  if (!raw) {
    warnings.push('ALLOWED_USER_IDS không có trong .env.');
    return [];
  }
  const ids: number[] = [];
  for (const part of raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    if (!/^\d+$/.test(part)) {
      warnings.push(`ALLOWED_USER_IDS có ID không hợp lệ, bỏ qua: ${part}`);
      continue;
    }
    const id = Number(part);
    if (!ids.includes(id)) ids.push(id);
  }
  const users: AllowedUser[] = [];
  for (const id of ids) users.push(await resolveUser(id, deps, warnings));
  return users;
}

/** Maps the claude-pager `.env` in `dir` onto the new config shape; setup validates and completes the result. */
export async function importLegacy(dir: string, deps: LegacyImportDeps): Promise<LegacyImport> {
  const warnings: string[] = [];
  const envPath = resolve(dir, '.env');
  const text = await deps.readFile(envPath);
  const env = text === null ? {} : parseDotEnv(text);
  if (text === null) warnings.push(`Không tìm thấy ${envPath}.`);

  const config: LegacyImport['config'] = { allowedUsers: [] };
  if (text !== null) {
    const value = (key: string): string | undefined => env[key]?.trim() || undefined;

    const token = value('TELEGRAM_BOT_TOKEN');
    if (token) config.telegram = { botToken: token };
    else warnings.push('TELEGRAM_BOT_TOKEN không có trong .env.');

    config.allowedUsers = await importUsers(value('ALLOWED_USER_IDS'), deps, warnings);

    const projectsRoot = value('PROJECTS_ROOT');
    if (projectsRoot) config.projectsRoot = projectsRoot;

    const idle = value('IDLE_TIMEOUT_MINUTES');
    if (idle !== undefined) {
      if (/^\d+$/.test(idle) && Number(idle) >= 1) config.idleTimeoutMinutes = Number(idle);
      else warnings.push(`IDLE_TIMEOUT_MINUTES không hợp lệ, dùng mặc định: ${idle}`);
    }

    const logLevel = value('LOG_LEVEL');
    if (logLevel !== undefined) {
      if (isLogLevel(logLevel)) config.logLevel = logLevel;
      else warnings.push(`LOG_LEVEL không hợp lệ, dùng mặc định: ${logLevel}`);
    }

    config.agent = {
      provider: LEGACY_PROVIDER,
      executable: value('CLAUDE_EXECUTABLE') ?? null,
      defaultModel: value('DEFAULT_MODEL') ?? null,
      defaultEffort: value('DEFAULT_EFFORT') ?? null,
    };
  }

  const statePath = resolve(dir, env.DATA_DIR?.trim() || 'data', 'state.json');
  const stateFile = (await deps.exists(statePath)) ? statePath : null;
  return { config, stateFile, warnings };
}
