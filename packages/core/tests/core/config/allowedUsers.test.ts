import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AllowedUsersRegistry, decideAuth, PairingError } from '../../../src/core/config/allowedUsers.js';
import type { AgentpagerConfig, AllowedUser } from '../../../src/core/config/schema.js';
import { ConfigStore } from '../../../src/core/config/store.js';
import { createFakeProvider } from '../../support/fakeProvider.js';

const users: AllowedUser[] = [
  { username: 'paired_user', userId: 42, pairedAt: '2026-09-14T06:00:00.000Z' },
  { username: 'waiting_user', userId: null, pairedAt: null },
];

describe('decideAuth', () => {
  it.each([
    ['a paired id', { fromId: 42, username: 'renamed', chatType: 'private' }, { kind: 'allow' }],
    ['a paired id without a username', { fromId: 42, username: undefined, chatType: 'private' }, { kind: 'allow' }],
    [
      'an unpaired username, case-insensitively',
      { fromId: 7, username: 'Waiting_User', chatType: 'private' },
      { kind: 'pair', username: 'waiting_user', userId: 7 },
    ],
    [
      'a username paired to another id',
      { fromId: 7, username: 'paired_user', chatType: 'private' },
      { kind: 'deny', reason: 'username_paired_to_other_id' },
    ],
    ['an unknown user', { fromId: 7, username: 'stranger', chatType: 'private' }, { kind: 'deny', reason: 'unknown_user' }],
    ['a user without username', { fromId: 7, username: undefined, chatType: 'private' }, { kind: 'deny', reason: 'unknown_user' }],
    ['a group chat', { fromId: 42, username: 'paired_user', chatType: 'group' }, { kind: 'deny', reason: 'not_private' }],
    ['a missing chat', { fromId: 42, username: 'paired_user', chatType: undefined }, { kind: 'deny', reason: 'not_private' }],
    ['a missing sender', { fromId: undefined, username: undefined, chatType: 'private' }, { kind: 'deny', reason: 'unknown_user' }],
  ])('%s', (_label, update, expected) => {
    expect(decideAuth(update, users)).toEqual(expected);
  });
});

function config(allowedUsers: AllowedUser[]): AgentpagerConfig {
  return {
    version: 1,
    telegram: { botToken: '123456:ABCdefGHIjklMNOpqrSTUvwx' },
    allowedUsers,
    projectsRoot: 'D:\\Projects',
    idleTimeoutMinutes: 60,
    logLevel: 'info',
    agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
  };
}

describe('AllowedUsersRegistry', () => {
  const pairedAt = new Date('2026-09-14T08:00:00.000Z');
  let store: ConfigStore;
  let registry: AllowedUsersRegistry;

  beforeEach(async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pager-users-')), 'config.json');
    store = new ConfigStore(file, { platform: process.platform, catalog: [createFakeProvider().provider] });
    await store.write(config(users));
    registry = new AllowedUsersRegistry(store, () => pairedAt);
  });

  it('is empty until loaded', async () => {
    expect(registry.current()).toEqual([]);
    await registry.load();
    expect(registry.current()).toEqual(users);
  });

  it('pairs a username, persists it and updates the in-memory list', async () => {
    await registry.load();
    await registry.pair('waiting_user', 7);
    const expected = { username: 'waiting_user', userId: 7, pairedAt: pairedAt.toISOString() };
    expect(registry.current()).toContainEqual(expected);
    expect((await store.read()).allowedUsers).toContainEqual(expected);
    expect(decideAuth({ fromId: 7, username: 'waiting_user', chatType: 'private' }, registry.current())).toEqual({
      kind: 'allow',
    });
  });

  it('treats pairing the same id again as done', async () => {
    await registry.load();
    await registry.pair('waiting_user', 7);
    await expect(registry.pair('waiting_user', 7)).resolves.toBeUndefined();
  });

  it('refuses when the file changed since the last load', async () => {
    await registry.load();
    await store.update((current) => ({
      ...current,
      allowedUsers: current.allowedUsers.map((user) => (user.username === 'waiting_user' ? { ...user, userId: 8 } : user)),
    }));
    await expect(registry.pair('waiting_user', 7)).rejects.toBeInstanceOf(PairingError);
    await expect(registry.pair('gone_user', 7)).rejects.toThrow('@gone_user không còn trong danh sách người dùng');
  });

  it('reload picks up external edits', async () => {
    await registry.load();
    await store.update((current) => ({
      ...current,
      allowedUsers: [...current.allowedUsers, { username: 'new_friend', userId: null, pairedAt: null }],
    }));
    expect(registry.current()).toHaveLength(2);
    await registry.reload();
    expect(registry.current()).toContainEqual({ username: 'new_friend', userId: null, pairedAt: null });
  });
});
