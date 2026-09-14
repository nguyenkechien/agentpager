import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importLegacy, parseDotEnv, type LegacyImportDeps } from '../../../src/core/config/importLegacy.js';

const DIR = resolve('legacy-app');

function fakeDeps(options: {
  env?: string;
  existing?: string[];
  chats?: Record<number, { username: string | null } | null | Error>;
}): LegacyImportDeps & { existsCalls: string[] } {
  const existsCalls: string[] = [];
  return {
    existsCalls,
    readFile: (path) => Promise.resolve(path === resolve(DIR, '.env') ? (options.env ?? null) : null),
    exists: (path) => {
      existsCalls.push(path);
      return Promise.resolve((options.existing ?? []).includes(path));
    },
    getChat: (userId) => {
      const chat = options.chats?.[userId];
      if (chat instanceof Error) return Promise.reject(chat);
      return Promise.resolve(chat ?? null);
    },
  };
}

describe('parseDotEnv', () => {
  it('reads keys, skips comments and blank lines, and unquotes values', () => {
    const text = [
      '# comment',
      'TELEGRAM_BOT_TOKEN=123:abc',
      '',
      '  ALLOWED_USER_IDS = 1, 2  ',
      'QUOTED="hello # world"',
      "SINGLE='x=y'",
      'INLINE=value # note',
      'EMPTY=',
      'NOEQUALS',
    ].join('\r\n');
    expect(parseDotEnv(text)).toEqual({
      TELEGRAM_BOT_TOKEN: '123:abc',
      ALLOWED_USER_IDS: '1, 2',
      QUOTED: 'hello # world',
      SINGLE: 'x=y',
      INLINE: 'value',
      EMPTY: '',
    });
  });
});

describe('importLegacy', () => {
  it('maps every legacy key and resolves user ids to usernames', async () => {
    const env = [
      'TELEGRAM_BOT_TOKEN=123456:ABCdefGHIjklMNOpqrSTUvwx',
      'ALLOWED_USER_IDS=111, 222,333,111',
      'CLAUDE_EXECUTABLE=C:\\Users\\alex\\.local\\bin\\claude.exe',
      'PROJECTS_ROOT=D:\\Projects',
      'IDLE_TIMEOUT_MINUTES=90',
      'DEFAULT_MODEL=opus',
      'DEFAULT_EFFORT=high',
      'LOG_LEVEL=debug',
    ].join('\n');
    const statePath = resolve(DIR, 'data', 'state.json');
    const deps = fakeDeps({
      env,
      existing: [statePath],
      chats: { 111: { username: 'Example_User' }, 222: { username: null }, 333: new Error('chat not found') },
    });

    const result = await importLegacy(DIR, deps);
    expect(result.config).toEqual({
      telegram: { botToken: '123456:ABCdefGHIjklMNOpqrSTUvwx' },
      allowedUsers: [
        { username: 'example_user', userId: 111, pairedAt: null },
        { username: null, userId: 222, pairedAt: null },
        { username: null, userId: 333, pairedAt: null },
      ],
      projectsRoot: 'D:\\Projects',
      idleTimeoutMinutes: 90,
      logLevel: 'debug',
      agent: {
        provider: 'claude-code',
        executable: 'C:\\Users\\alex\\.local\\bin\\claude.exe',
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
    });
    expect(result.stateFile).toBe(statePath);
    expect(result.warnings).toEqual([
      'Không tìm được username của user 222 (không có username) — giữ theo ID.',
      'Không tìm được username của user 333 (chat not found) — giữ theo ID.',
    ]);
  });

  it('warns about invalid values and uses DATA_DIR for the state file', async () => {
    const deps = fakeDeps({
      env: ['ALLOWED_USER_IDS=12,abc', 'IDLE_TIMEOUT_MINUTES=0', 'LOG_LEVEL=loud', 'DATA_DIR=state-dir'].join('\n'),
      chats: { 12: { username: 'bad-name' } },
    });
    const result = await importLegacy(DIR, deps);

    expect(result.config).toEqual({
      allowedUsers: [{ username: null, userId: 12, pairedAt: null }],
      agent: { provider: 'claude-code', executable: null, defaultModel: null, defaultEffort: null },
    });
    expect(result.warnings).toEqual([
      'TELEGRAM_BOT_TOKEN không có trong .env.',
      'ALLOWED_USER_IDS có ID không hợp lệ, bỏ qua: abc',
      expect.stringMatching(/^Không tìm được username của user 12 \(Username không hợp lệ: "bad-name"/),
      'IDLE_TIMEOUT_MINUTES không hợp lệ, dùng mặc định: 0',
      'LOG_LEVEL không hợp lệ, dùng mặc định: loud',
    ]);
    expect(result.stateFile).toBeNull();
    expect(deps.existsCalls).toEqual([resolve(DIR, 'state-dir', 'state.json')]);
  });

  it('reports a missing .env but still finds the state file', async () => {
    const statePath = resolve(DIR, 'data', 'state.json');
    const result = await importLegacy(DIR, fakeDeps({ existing: [statePath] }));
    expect(result).toEqual({
      config: { allowedUsers: [] },
      stateFile: statePath,
      warnings: [`Không tìm thấy ${resolve(DIR, '.env')}.`],
    });
  });

  it('warns when no user ids are configured', async () => {
    const result = await importLegacy(DIR, fakeDeps({ env: 'TELEGRAM_BOT_TOKEN=123456:ABCdefGHIjklMNOpqrSTUvwx' }));
    expect(result.config.allowedUsers).toEqual([]);
    expect(result.warnings).toEqual(['ALLOWED_USER_IDS không có trong .env.']);
  });
});
