import type { Context } from 'grammy';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware, isAuthorized } from '../../../src/core/bot/auth.js';

const allowed = new Set([42]);

describe('isAuthorized', () => {
  it.each([
    [{ fromId: 42, chatType: 'private' }, true],
    [{ fromId: 42, chatType: 'group' }, false],
    [{ fromId: 42, chatType: 'supergroup' }, false],
    [{ fromId: 7, chatType: 'private' }, false],
    [{ fromId: undefined, chatType: 'private' }, false],
    [{ fromId: 42, chatType: undefined }, false],
  ])('%j → %s', (update, expected) => {
    expect(isAuthorized(update, allowed)).toBe(expected);
  });
});

describe('createAuthMiddleware', () => {
  function context(fromId: number, chatType: string): Context {
    return {
      from: { id: fromId, username: 'someone' },
      chat: { id: fromId, type: chatType },
      update: { update_id: 1 },
    } as unknown as Context;
  }

  it('passes allowed users through', async () => {
    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const next = vi.fn(() => Promise.resolve());
    await createAuthMiddleware(allowed, logger)(context(42, 'private'), next);
    expect(next).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('silently drops and logs everyone else', async () => {
    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const next = vi.fn(() => Promise.resolve());
    await createAuthMiddleware(allowed, logger)(context(7, 'private'), next);
    await createAuthMiddleware(allowed, logger)(context(42, 'group'), next);
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
