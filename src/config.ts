import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { claudeCodeCatalog } from './providers/claude-code/index.js';

export const DEFAULT_PROJECTS_ROOT = 'D:\\Projects';
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export interface AppConfig {
  telegramBotToken: string;
  allowedUserIds: ReadonlySet<number>;
  claudeExecutable: string;
  projectsRoot: string;
  idleTimeoutMs: number;
  defaultModel: string | null;
  defaultEffort: string | null;
  dataDir: string;
  logLevel: string;
  projectDir: string;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

export function parseConfig(env: Record<string, string | undefined>, projectDir: string): AppConfig {
  const issues: string[] = [];

  const telegramBotToken = nonEmpty(env.TELEGRAM_BOT_TOKEN);
  if (!telegramBotToken) issues.push('TELEGRAM_BOT_TOKEN is required');

  const allowedUserIds = new Set<number>();
  const rawIds = nonEmpty(env.ALLOWED_USER_IDS);
  if (!rawIds) {
    issues.push('ALLOWED_USER_IDS is required (comma-separated Telegram user ids)');
  } else {
    const parts = rawIds.split(',').map((part) => part.trim());
    const invalid = parts.filter((part) => !/^\d+$/.test(part));
    if (invalid.length > 0) {
      issues.push(`ALLOWED_USER_IDS contains invalid ids: ${JSON.stringify(invalid)}`);
    } else {
      for (const part of parts) allowedUserIds.add(Number(part));
    }
  }

  const claudeExecutable = nonEmpty(env.CLAUDE_EXECUTABLE);
  if (!claudeExecutable) {
    issues.push('CLAUDE_EXECUTABLE is required (absolute path to claude.exe)');
  } else if (!isAbsolute(claudeExecutable)) {
    issues.push(`CLAUDE_EXECUTABLE must be an absolute path: ${claudeExecutable}`);
  } else if (!isFile(claudeExecutable)) {
    issues.push(`CLAUDE_EXECUTABLE does not exist or is not a file: ${claudeExecutable}`);
  }

  const projectsRoot = resolve(nonEmpty(env.PROJECTS_ROOT) ?? DEFAULT_PROJECTS_ROOT);
  if (!isDirectory(projectsRoot)) issues.push(`PROJECTS_ROOT is not an existing directory: ${projectsRoot}`);

  let idleTimeoutMs = 60 * 60 * 1000;
  const rawIdle = nonEmpty(env.IDLE_TIMEOUT_MINUTES);
  if (rawIdle !== null) {
    if (/^\d+$/.test(rawIdle) && Number(rawIdle) >= 1) {
      idleTimeoutMs = Number(rawIdle) * 60 * 1000;
    } else {
      issues.push(`IDLE_TIMEOUT_MINUTES must be an integer >= 1: ${rawIdle}`);
    }
  }

  const modelIds = claudeCodeCatalog.models.map((option) => option.id);
  let defaultModel: string | null = null;
  const rawModel = nonEmpty(env.DEFAULT_MODEL);
  if (rawModel !== null) {
    if (modelIds.includes(rawModel)) defaultModel = rawModel;
    else issues.push(`DEFAULT_MODEL must be one of ${modelIds.join(', ')}: ${rawModel}`);
  }

  const efforts = claudeCodeCatalog.efforts;
  let defaultEffort: string | null = null;
  const rawEffort = nonEmpty(env.DEFAULT_EFFORT);
  if (rawEffort !== null) {
    if (efforts.includes(rawEffort)) defaultEffort = rawEffort;
    else issues.push(`DEFAULT_EFFORT must be one of ${efforts.join(', ')}: ${rawEffort}`);
  }

  const logLevel = nonEmpty(env.LOG_LEVEL) ?? 'info';
  if (!oneOf(logLevel, LOG_LEVELS)) issues.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}: ${logLevel}`);

  const dataDir = resolve(projectDir, nonEmpty(env.DATA_DIR) ?? 'data');

  if (issues.length > 0 || !telegramBotToken || !claudeExecutable) throw new ConfigError(issues);

  return {
    telegramBotToken,
    allowedUserIds,
    claudeExecutable,
    projectsRoot,
    idleTimeoutMs,
    defaultModel,
    defaultEffort,
    dataDir,
    logLevel,
    projectDir,
  };
}
