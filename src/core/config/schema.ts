import { posix, win32 } from 'node:path';
import { z } from 'zod';
import type { ProviderCatalogEntry } from '../../providers/types.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AllowedUser {
  /** Lowercase, without `@`; null for an entry imported from a legacy user id whose username is unknown. */
  username: string | null;
  /** Null until the username sends its first private message. */
  userId: number | null;
  pairedAt: string | null;
}

export interface AgentSettings {
  provider: string;
  executable: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
}

export interface AgentpagerConfig {
  version: 1;
  telegram: { botToken: string };
  allowedUsers: AllowedUser[];
  projectsRoot: string;
  idleTimeoutMinutes: number;
  logLevel: LogLevel;
  agent: AgentSettings;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Cấu hình không hợp lệ:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const USERNAME_PATTERN = /^[a-z0-9_]{5,32}$/;
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const USERNAME_RULE = '5–32 ký tự a-z, 0-9, _';

const allowedUserSchema = z.object({
  username: z.string().nullable(),
  userId: z.number().int().positive().nullable(),
  pairedAt: z.string().nullable(),
});

const configSchema = z.object({
  version: z.literal(1),
  telegram: z.object({ botToken: z.string() }),
  allowedUsers: z.array(allowedUserSchema),
  projectsRoot: z.string(),
  idleTimeoutMinutes: z.number().int('phải là số nguyên').min(1, 'phải ≥ 1').default(60),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  agent: z.object({
    provider: z.string().min(1),
    executable: z.string().nullable().default(null),
    defaultModel: z.string().nullable().default(null),
    defaultEffort: z.string().nullable().default(null),
  }),
});

/** Strips a leading `@` and lowercases: Telegram usernames are case-insensitive. */
export function normalizeUsername(input: string): string {
  const normalized = input.trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) throw new ConfigError([`Username không hợp lệ: "${input}" (${USERNAME_RULE})`]);
  return normalized;
}

export function maskToken(token: string): string {
  return token.length <= 9 ? '…' : `${token.slice(0, 6)}…${token.slice(-3)}`;
}

/** The config is shared across machines' tooling, so either path style counts as absolute. */
function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

function checkUsers(users: readonly AllowedUser[], issues: string[]): void {
  if (users.length === 0) issues.push('allowedUsers: cần ít nhất 1 người dùng');
  const usernames = new Set<string>();
  const ids = new Set<number>();
  users.forEach((user, index) => {
    const at = `allowedUsers[${index}]`;
    if (user.username === null && user.userId === null) issues.push(`${at}: cần username hoặc userId`);
    if (user.username !== null) {
      if (!USERNAME_PATTERN.test(user.username)) {
        issues.push(`${at}.username: "${user.username}" không hợp lệ (viết thường, không có @, ${USERNAME_RULE})`);
      } else if (usernames.has(user.username)) {
        issues.push(`${at}.username: @${user.username} bị trùng`);
      } else {
        usernames.add(user.username);
      }
    }
    if (user.userId !== null) {
      if (ids.has(user.userId)) issues.push(`${at}.userId: ${user.userId} bị trùng`);
      ids.add(user.userId);
    }
  });
}

function checkAgent(agent: AgentSettings, catalog: readonly ProviderCatalogEntry[], issues: string[]): void {
  const provider = catalog.find((entry) => entry.id === agent.provider);
  if (!provider) {
    issues.push(`agent.provider: không có provider "${agent.provider}" (có: ${catalog.map((entry) => entry.id).join(', ')})`);
  } else {
    const modelIds = provider.models.map((model) => model.id);
    if (agent.defaultModel !== null && !modelIds.includes(agent.defaultModel)) {
      issues.push(`agent.defaultModel: "${agent.defaultModel}" không có trong ${provider.displayName} (có: ${modelIds.join(', ')})`);
    }
    if (agent.defaultEffort !== null && !provider.efforts.includes(agent.defaultEffort)) {
      issues.push(
        `agent.defaultEffort: "${agent.defaultEffort}" không có trong ${provider.displayName} (có: ${provider.efforts.join(', ')})`,
      );
    }
  }
  if (agent.executable !== null && !isAbsolutePath(agent.executable)) {
    issues.push(`agent.executable: phải là đường dẫn tuyệt đối: ${agent.executable}`);
  }
}

/** Throws one ConfigError listing every problem found. */
export function validateConfig(raw: unknown, catalog: readonly ProviderCatalogEntry[]): AgentpagerConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(gốc)'}: ${issue.message}`));
  }
  const config = parsed.data;
  const issues: string[] = [];
  if (!TOKEN_PATTERN.test(config.telegram.botToken)) {
    issues.push('telegram.botToken: không đúng định dạng token của BotFather (<số>:<chuỗi>)');
  }
  checkUsers(config.allowedUsers, issues);
  if (!isAbsolutePath(config.projectsRoot)) issues.push(`projectsRoot: phải là đường dẫn tuyệt đối: ${config.projectsRoot}`);
  checkAgent(config.agent, catalog, issues);
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}
