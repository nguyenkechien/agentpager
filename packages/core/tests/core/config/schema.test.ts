import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  maskToken,
  normalizeUsername,
  validateConfig,
  type AgentpagerConfig,
} from '../../../src/core/config/schema.js';
import { createFakeProvider } from '../../support/fakeProvider.js';

const catalog = [createFakeProvider().provider];
const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwx';

function valid(): AgentpagerConfig {
  return {
    version: 1,
    telegram: { botToken: TOKEN },
    allowedUsers: [{ username: 'example_user', userId: 123456789, pairedAt: '2026-09-14T06:00:00.000Z' }],
    projectsRoot: 'D:\\Projects',
    idleTimeoutMinutes: 60,
    logLevel: 'info',
    agent: { provider: 'fake', executable: null, defaultModel: 'smart', defaultEffort: 'low' },
  };
}

function issuesOf(raw: unknown): string[] {
  try {
    validateConfig(raw, catalog);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    expect(validateConfig(valid(), catalog)).toEqual(valid());
  });

  it('applies defaults for optional settings', () => {
    const raw = {
      version: 1,
      telegram: { botToken: TOKEN },
      allowedUsers: [{ username: 'example_user', userId: null, pairedAt: null }],
      projectsRoot: '/Users/alex/Projects',
      agent: { provider: 'fake' },
    };
    expect(validateConfig(raw, catalog)).toMatchObject({
      idleTimeoutMinutes: 60,
      logLevel: 'info',
      agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
    });
  });

  it('accepts paired and pending users', () => {
    const config = {
      ...valid(),
      allowedUsers: [
        { username: 'first_user', userId: 42, pairedAt: '2026-09-14T06:00:00.000Z' },
        { username: 'second_user', userId: null, pairedAt: null },
      ],
    };
    expect(issuesOf(config)).toEqual([]);
  });

  it('reports every problem at once', () => {
    const issues = issuesOf({
      ...valid(),
      telegram: { botToken: 'nope' },
      allowedUsers: [],
      projectsRoot: 'Projects',
      agent: { provider: 'fake', executable: 'claude.exe', defaultModel: 'opus', defaultEffort: 'max' },
    });
    expect(issues).toEqual([
      expect.stringMatching(/^telegram\.botToken: /),
      'allowedUsers: at least 1 user is required',
      'projectsRoot: must be an absolute path: Projects',
      'agent.defaultModel: "opus" is not available in Fake Agent (available: fast, smart)',
      'agent.defaultEffort: "max" is not available in Fake Agent (available: low, high)',
      'agent.executable: must be an absolute path: claude.exe',
    ]);
  });

  it('checks user entries', () => {
    const issues = issuesOf({
      ...valid(),
      allowedUsers: [
        { username: '@Bad', userId: null, pairedAt: null },
        { username: 'example_user', userId: 1, pairedAt: null },
        { username: 'example_user', userId: 1, pairedAt: null },
      ],
    });
    expect(issues).toEqual([
      expect.stringMatching(/^allowedUsers\[0\]\.username: "@Bad" is invalid/),
      'allowedUsers[2].username: @example_user is a duplicate',
      'allowedUsers[2].userId: 1 is a duplicate',
    ]);
  });

  it('requires a username on every user', () => {
    expect(issuesOf({ ...valid(), allowedUsers: [{ username: null, userId: 1, pairedAt: null }] }).join()).toMatch(
      /^allowedUsers\.0\.username: /,
    );
  });

  it('names the known providers for an unknown one', () => {
    expect(issuesOf({ ...valid(), agent: { ...valid().agent, provider: 'codex' } })).toEqual([
      'agent.provider: no provider "codex" (available: fake)',
    ]);
  });

  it('rejects a wrong shape and invalid idle timeouts', () => {
    expect(issuesOf('not an object').length).toBeGreaterThan(0);
    expect(issuesOf({ ...valid(), version: 2 }).join()).toMatch(/^version: /);
    expect(issuesOf({ ...valid(), idleTimeoutMinutes: 0 })).toEqual(['idleTimeoutMinutes: must be ≥ 1']);
    expect(issuesOf({ ...valid(), idleTimeoutMinutes: 1.5 })).toEqual(['idleTimeoutMinutes: must be an integer']);
    expect(issuesOf({ ...valid(), logLevel: 'loud' }).join()).toMatch(/^logLevel: /);
  });

  it('lists the issues in the error message', () => {
    expect(() => validateConfig({ ...valid(), allowedUsers: [] }, catalog)).toThrow(
      'Invalid config:\n- allowedUsers: at least 1 user is required',
    );
  });
});

describe('normalizeUsername', () => {
  it.each([
    ['@Example_User', 'example_user'],
    ['  alex_01 ', 'alex_01'],
    ['abcde', 'abcde'],
  ])('%j → %s', (input, expected) => {
    expect(normalizeUsername(input)).toBe(expected);
  });

  it.each(['abcd', 'has-dash', 'a'.repeat(33), '@@double', ''])('rejects %j', (input) => {
    expect(() => normalizeUsername(input)).toThrow(ConfigError);
  });
});

describe('maskToken', () => {
  it('keeps only the start and the end of the token', () => {
    expect(maskToken(TOKEN)).toBe('123456…vwx');
    expect(maskToken('short')).toBe('…');
  });
});
