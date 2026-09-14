import type { Context } from 'grammy';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from '../../../src/core/bot/auth.js';
import type { AllowedUsersSource } from '../../../src/core/config/allowedUsers.js';
import type { AllowedUser } from '../../../src/core/config/schema.js';

function fakeUsers(initial: AllowedUser[], failPairing = false) {
  let list = initial;
  const pair = vi.fn((username: string, userId: number) => {
    if (failPairing) return Promise.reject(new Error('disk full'));
    list = list.map((user) => (user.username === username ? { ...user, userId, pairedAt: 'now' } : user));
    return Promise.resolve();
  });
  const source: AllowedUsersSource = { current: () => list, pair };
  return { source, pair };
}

function context(fromId: number, username: string | undefined, chatType: string, callback = false) {
  const reply = vi.fn(() => Promise.resolve());
  const ctx = {
    from: { id: fromId, username },
    chat: { id: fromId, type: chatType },
    update: { update_id: 1 },
    ...(callback ? { callbackQuery: { id: 'cb', data: 'x' } } : {}),
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

function setup(users: AllowedUser[], failPairing = false) {
  const logger = pino({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  const { source, pair } = fakeUsers(users, failPairing);
  const next = vi.fn(() => Promise.resolve());
  return { middleware: createAuthMiddleware(source, logger), warn, error, pair, next };
}

const waiting: AllowedUser = { username: 'waiting_user', userId: null, pairedAt: null };
const paired: AllowedUser = { username: 'paired_user', userId: 42, pairedAt: '2026-09-14T06:00:00.000Z' };

describe('createAuthMiddleware', () => {
  it('passes paired users through, for messages and callback queries', async () => {
    const { middleware, next, warn } = setup([paired]);
    await middleware(context(42, 'paired_user', 'private').ctx, next);
    await middleware(context(42, undefined, 'private', true).ctx, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('pairs a listed username once, confirms it and handles the update', async () => {
    const { middleware, next, pair } = setup([waiting]);
    const first = context(7, 'Waiting_User', 'private');
    await middleware(first.ctx, next);
    expect(pair).toHaveBeenCalledWith('waiting_user', 7);
    expect(first.reply).toHaveBeenCalledWith('✅ Đã ghép @waiting_user với agentpager.');
    expect(next).toHaveBeenCalledOnce();

    const second = context(7, 'waiting_user', 'private');
    await middleware(second.ctx, next);
    expect(pair).toHaveBeenCalledOnce();
    expect(second.reply).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('ignores the update when pairing cannot be saved', async () => {
    const { middleware, next, error } = setup([waiting], true);
    const { ctx, reply } = context(7, 'waiting_user', 'private');
    await middleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('silently drops and logs everyone else with the reason', async () => {
    const { middleware, next, warn } = setup([paired]);
    const stranger = context(7, 'stranger', 'private');
    await middleware(stranger.ctx, next);
    await middleware(context(8, 'paired_user', 'private').ctx, next);
    await middleware(context(42, 'paired_user', 'group').ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(stranger.reply).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => [(call[0] as { reason: string }).reason, call[1]])).toEqual([
      ['unknown_user', 'ignored update from unauthorized user'],
      ['username_paired_to_other_id', 'username matches a paired user with a different id'],
      ['not_private', 'ignored update from a non-private chat'],
    ]);
  });
});
