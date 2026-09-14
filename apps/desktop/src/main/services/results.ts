import { ConfigError, MISSING_CONFIG_MESSAGE } from '@chiennguyen/agentpager/config';
import { IpcError } from '@chiennguyen/agentpager/daemon';
import type { ApiError, ApiResult, FieldErrors, SettingsField } from '../../shared/api.js';

/** An expected failure a service reports to the renderer as-is. */
export class ApiFailure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiFailure';
  }
}

export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

/** Config paths the core reports, most specific first, and the form field that shows them. */
const FIELD_PATHS: readonly (readonly [string, SettingsField])[] = [
  ['telegram.botToken', 'botToken'],
  ['projectsRoot', 'projectsRoot'],
  ['idleTimeoutMinutes', 'idleTimeoutMinutes'],
  ['logLevel', 'logLevel'],
  ['agent.provider', 'agent.provider'],
  ['agent.executable', 'agent.executable'],
  ['agent.defaultModel', 'agent.defaultModel'],
  ['agent.defaultEffort', 'agent.defaultEffort'],
  ['allowedUsers', 'allowedUsers'],
];

/** Core issues look like `path: message`, e.g. `allowedUsers[0].username: …`. */
const ISSUE_PATTERN = /^([A-Za-z_][\w.[\]]*): (.+)$/s;

function fieldOf(path: string): SettingsField {
  for (const [prefix, field] of FIELD_PATHS) {
    if (path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)) return field;
  }
  return 'form';
}

export function fieldErrorsFromIssues(issues: readonly string[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const match = ISSUE_PATTERN.exec(issue);
    const field = match?.[1] ? fieldOf(match[1]) : 'form';
    const message = match?.[1] && field !== 'form' ? (match[2] ?? issue) : issue;
    (errors[field] ??= []).push(message);
  }
  return errors;
}

export function isMissingConfig(error: ConfigError): boolean {
  return error.issues.length === 1 && error.issues[0] === MISSING_CONFIG_MESSAGE;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiFailure) return error.error;
  if (error instanceof ConfigError) {
    if (isMissingConfig(error)) return { code: 'missing_config', message: MISSING_CONFIG_MESSAGE };
    return { code: 'invalid_config', message: error.issues.join('\n'), fieldErrors: fieldErrorsFromIssues(error.issues) };
  }
  if (error instanceof IpcError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'failed', message: error.message };
  return { code: 'failed', message: String(error) };
}
