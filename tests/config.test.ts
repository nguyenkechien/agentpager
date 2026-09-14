import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_PROJECTS_ROOT, parseConfig } from '../src/config.js';

let root: string;
let exe: string;
let projects: string;

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    TELEGRAM_BOT_TOKEN: '123:abc',
    ALLOWED_USER_IDS: '42',
    CLAUDE_EXECUTABLE: exe,
    PROJECTS_ROOT: projects,
    ...overrides,
  };
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected ConfigError');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pager-config-'));
  exe = join(root, 'claude.exe');
  writeFileSync(exe, '');
  projects = join(root, 'projects');
  mkdirSync(projects);
});

describe('parseConfig', () => {
  it('applies defaults for optional values', () => {
    const config = parseConfig(baseEnv(), root);
    expect(config.telegramBotToken).toBe('123:abc');
    expect([...config.allowedUserIds]).toEqual([42]);
    expect(config.claudeExecutable).toBe(exe);
    expect(config.projectsRoot).toBe(projects);
    expect(config.idleTimeoutMs).toBe(3_600_000);
    expect(config.defaultModel).toBeNull();
    expect(config.defaultEffort).toBeNull();
    expect(config.dataDir).toBe(join(root, 'data'));
    expect(config.logLevel).toBe('info');
    expect(config.projectDir).toBe(root);
  });

  it('uses D:\\Projects as the default projects root', () => {
    expect(DEFAULT_PROJECTS_ROOT).toBe('D:\\Projects');
  });

  it('reports every missing required variable', () => {
    const issues = issuesOf(() =>
      parseConfig(
        baseEnv({ TELEGRAM_BOT_TOKEN: undefined, ALLOWED_USER_IDS: undefined, CLAUDE_EXECUTABLE: undefined }),
        root,
      ),
    );
    expect(issues.join('\n')).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(issues.join('\n')).toMatch(/ALLOWED_USER_IDS/);
    expect(issues.join('\n')).toMatch(/CLAUDE_EXECUTABLE/);
  });

  it('parses a comma-separated user id list', () => {
    const config = parseConfig(baseEnv({ ALLOWED_USER_IDS: '1, 2' }), root);
    expect([...config.allowedUserIds].sort()).toEqual([1, 2]);
  });

  it.each(['abc', '', ' , ', '1,x', '-5', '1.5'])('rejects ALLOWED_USER_IDS=%j', (value) => {
    expect(issuesOf(() => parseConfig(baseEnv({ ALLOWED_USER_IDS: value }), root)).join()).toMatch(/ALLOWED_USER_IDS/);
  });

  it('rejects a relative or missing claude executable', () => {
    expect(issuesOf(() => parseConfig(baseEnv({ CLAUDE_EXECUTABLE: 'claude.exe' }), root)).join()).toMatch(
      /CLAUDE_EXECUTABLE/,
    );
    expect(
      issuesOf(() => parseConfig(baseEnv({ CLAUDE_EXECUTABLE: join(root, 'missing.exe') }), root)).join(),
    ).toMatch(/CLAUDE_EXECUTABLE/);
  });

  it('rejects a projects root that is not a directory', () => {
    expect(issuesOf(() => parseConfig(baseEnv({ PROJECTS_ROOT: exe }), root)).join()).toMatch(/PROJECTS_ROOT/);
    expect(issuesOf(() => parseConfig(baseEnv({ PROJECTS_ROOT: join(root, 'nope') }), root)).join()).toMatch(
      /PROJECTS_ROOT/,
    );
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects IDLE_TIMEOUT_MINUTES=%j', (value) => {
    expect(issuesOf(() => parseConfig(baseEnv({ IDLE_TIMEOUT_MINUTES: value }), root)).join()).toMatch(
      /IDLE_TIMEOUT_MINUTES/,
    );
  });

  it('accepts valid optional values', () => {
    const config = parseConfig(
      baseEnv({
        IDLE_TIMEOUT_MINUTES: '5',
        DEFAULT_MODEL: 'sonnet',
        DEFAULT_EFFORT: 'xhigh',
        DATA_DIR: 'state',
        LOG_LEVEL: 'debug',
      }),
      root,
    );
    expect(config.idleTimeoutMs).toBe(300_000);
    expect(config.defaultModel).toBe('sonnet');
    expect(config.defaultEffort).toBe('xhigh');
    expect(config.dataDir).toBe(join(root, 'state'));
    expect(config.logLevel).toBe('debug');
  });

  it('rejects unknown model, effort and log level', () => {
    const issues = issuesOf(() =>
      parseConfig(baseEnv({ DEFAULT_MODEL: 'gpt', DEFAULT_EFFORT: 'ultra', LOG_LEVEL: 'loud' }), root),
    ).join('\n');
    expect(issues).toMatch(/DEFAULT_MODEL/);
    expect(issues).toMatch(/DEFAULT_EFFORT/);
    expect(issues).toMatch(/LOG_LEVEL/);
  });
});
