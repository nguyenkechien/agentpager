import { ConfigError, MISSING_CONFIG_MESSAGE } from '@chiennguyen/agentpager/config';
import { IpcError } from '@chiennguyen/agentpager/daemon';
import { describe, expect, it } from 'vitest';
import { ApiFailure, fieldErrorsFromIssues, ok, toApiError } from '../../../src/main/services/results.js';

describe('fieldErrorsFromIssues', () => {
  it('maps every config path the core reports to its form field', () => {
    expect(
      fieldErrorsFromIssues([
        'telegram.botToken: not a valid BotFather token (<number>:<string>)',
        'projectsRoot: must be an absolute path: Projects',
        'idleTimeoutMinutes: must be ≥ 1',
        'logLevel: Invalid option',
        'agent.provider: no provider "x" (available: claude-code)',
        'agent.executable: must be an absolute path: claude',
        'agent.defaultModel: "x" is not available in Claude Code (available: opus)',
        'agent.defaultEffort: "x" is not available in Claude Code (available: high)',
        'allowedUsers: at least 1 user is required',
        'allowedUsers[1].username: @bob_two is a duplicate',
      ]),
    ).toEqual({
      botToken: ['not a valid BotFather token (<number>:<string>)'],
      projectsRoot: ['must be an absolute path: Projects'],
      idleTimeoutMinutes: ['must be ≥ 1'],
      logLevel: ['Invalid option'],
      'agent.provider': ['no provider "x" (available: claude-code)'],
      'agent.executable': ['must be an absolute path: claude'],
      'agent.defaultModel': ['"x" is not available in Claude Code (available: opus)'],
      'agent.defaultEffort': ['"x" is not available in Claude Code (available: high)'],
      allowedUsers: ['at least 1 user is required', '@bob_two is a duplicate'],
    });
  });

  it('keeps issues without a known field path whole under the form', () => {
    expect(
      fieldErrorsFromIssues([
        '(root): Invalid input',
        'version: Invalid input: expected 1',
        'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\config.json is not valid JSON: Unexpected token',
        'Invalid username: "@x" (5–32 characters a-z, 0-9, _)',
      ]),
    ).toEqual({
      form: [
        '(root): Invalid input',
        'version: Invalid input: expected 1',
        'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\config.json is not valid JSON: Unexpected token',
        'Invalid username: "@x" (5–32 characters a-z, 0-9, _)',
      ],
    });
  });
});

describe('toApiError', () => {
  it('passes expected failures through', () => {
    const error = { code: 'invalid_token' as const, message: 'Invalid token' };
    expect(toApiError(new ApiFailure(error))).toEqual(error);
  });

  it('distinguishes a missing config from an invalid one', () => {
    expect(toApiError(new ConfigError([MISSING_CONFIG_MESSAGE]))).toEqual({ code: 'missing_config', message: MISSING_CONFIG_MESSAGE });
    expect(toApiError(new ConfigError(['projectsRoot: must be an absolute path: x', 'allowedUsers: at least 1 user is required']))).toEqual({
      code: 'invalid_config',
      message: 'projectsRoot: must be an absolute path: x\nallowedUsers: at least 1 user is required',
      fieldErrors: { projectsRoot: ['must be an absolute path: x'], allowedUsers: ['at least 1 user is required'] },
    });
  });

  it('keeps IPC error codes and reports anything else as failed', () => {
    expect(toApiError(new IpcError('timeout', 'Daemon did not respond after 5000 ms'))).toEqual({
      code: 'timeout',
      message: 'Daemon did not respond after 5000 ms',
    });
    expect(toApiError(new IpcError('unauthorized', 'Sai token'))).toMatchObject({ code: 'unauthorized' });
    expect(toApiError(new Error('boom'))).toEqual({ code: 'failed', message: 'boom' });
    expect(toApiError('plain')).toEqual({ code: 'failed', message: 'plain' });
  });

  it('wraps data', () => {
    expect(ok(3)).toEqual({ ok: true, data: 3 });
  });
});
