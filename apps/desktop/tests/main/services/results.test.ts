import { ConfigError, MISSING_CONFIG_MESSAGE } from '@chiennguyen/agentpager/config';
import { IpcError } from '@chiennguyen/agentpager/daemon';
import { describe, expect, it } from 'vitest';
import { ApiFailure, fieldErrorsFromIssues, ok, toApiError } from '../../../src/main/services/results.js';

describe('fieldErrorsFromIssues', () => {
  it('maps every config path the core reports to its form field', () => {
    expect(
      fieldErrorsFromIssues([
        'telegram.botToken: không đúng định dạng token của BotFather (<số>:<chuỗi>)',
        'projectsRoot: phải là đường dẫn tuyệt đối: Projects',
        'idleTimeoutMinutes: phải ≥ 1',
        'logLevel: Invalid option',
        'agent.provider: không có provider "x" (có: claude-code)',
        'agent.executable: phải là đường dẫn tuyệt đối: claude',
        'agent.defaultModel: "x" không có trong Claude Code (có: opus)',
        'agent.defaultEffort: "x" không có trong Claude Code (có: high)',
        'allowedUsers: cần ít nhất 1 người dùng',
        'allowedUsers[1].username: @bob_two bị trùng',
      ]),
    ).toEqual({
      botToken: ['không đúng định dạng token của BotFather (<số>:<chuỗi>)'],
      projectsRoot: ['phải là đường dẫn tuyệt đối: Projects'],
      idleTimeoutMinutes: ['phải ≥ 1'],
      logLevel: ['Invalid option'],
      'agent.provider': ['không có provider "x" (có: claude-code)'],
      'agent.executable': ['phải là đường dẫn tuyệt đối: claude'],
      'agent.defaultModel': ['"x" không có trong Claude Code (có: opus)'],
      'agent.defaultEffort': ['"x" không có trong Claude Code (có: high)'],
      allowedUsers: ['cần ít nhất 1 người dùng', '@bob_two bị trùng'],
    });
  });

  it('keeps issues without a known field path whole under the form', () => {
    expect(
      fieldErrorsFromIssues([
        '(gốc): Invalid input',
        'version: Invalid input: expected 1',
        'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\config.json không phải JSON hợp lệ: Unexpected token',
        'Username không hợp lệ: "@x" (5–32 ký tự a-z, 0-9, _)',
      ]),
    ).toEqual({
      form: [
        '(gốc): Invalid input',
        'version: Invalid input: expected 1',
        'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\config.json không phải JSON hợp lệ: Unexpected token',
        'Username không hợp lệ: "@x" (5–32 ký tự a-z, 0-9, _)',
      ],
    });
  });
});

describe('toApiError', () => {
  it('passes expected failures through', () => {
    const error = { code: 'invalid_token' as const, message: 'Token không hợp lệ' };
    expect(toApiError(new ApiFailure(error))).toEqual(error);
  });

  it('distinguishes a missing config from an invalid one', () => {
    expect(toApiError(new ConfigError([MISSING_CONFIG_MESSAGE]))).toEqual({ code: 'missing_config', message: MISSING_CONFIG_MESSAGE });
    expect(toApiError(new ConfigError(['projectsRoot: phải là đường dẫn tuyệt đối: x', 'allowedUsers: cần ít nhất 1 người dùng']))).toEqual({
      code: 'invalid_config',
      message: 'projectsRoot: phải là đường dẫn tuyệt đối: x\nallowedUsers: cần ít nhất 1 người dùng',
      fieldErrors: { projectsRoot: ['phải là đường dẫn tuyệt đối: x'], allowedUsers: ['cần ít nhất 1 người dùng'] },
    });
  });

  it('keeps IPC error codes and reports anything else as failed', () => {
    expect(toApiError(new IpcError('timeout', 'Daemon không phản hồi sau 5000 ms'))).toEqual({
      code: 'timeout',
      message: 'Daemon không phản hồi sau 5000 ms',
    });
    expect(toApiError(new IpcError('unauthorized', 'Sai token'))).toMatchObject({ code: 'unauthorized' });
    expect(toApiError(new Error('boom'))).toEqual({ code: 'failed', message: 'boom' });
    expect(toApiError('plain')).toEqual({ code: 'failed', message: 'plain' });
  });

  it('wraps data', () => {
    expect(ok(3)).toEqual({ ok: true, data: 3 });
  });
});
