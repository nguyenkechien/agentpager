import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { checkTokenWithTelegram, classifyTelegramError } from '../../../src/main/services/telegramCheck.js';

function apiError(code: number, description: string): GrammyError {
  return new GrammyError(`Call to 'getMe' failed! (${String(code)}: ${description})`, { ok: false, error_code: code, description }, 'getMe', {});
}

describe('classifyTelegramError', () => {
  it('treats 401 and 404 as a rejected token', () => {
    expect(classifyTelegramError(apiError(401, 'Unauthorized'))).toEqual({ kind: 'invalid', message: '401 Unauthorized' });
    expect(classifyTelegramError(apiError(404, 'Not Found'))).toEqual({ kind: 'invalid', message: '404 Not Found' });
  });

  it('treats other failures as "could not check now"', () => {
    expect(classifyTelegramError(apiError(429, 'Too Many Requests: retry after 5'))).toEqual({
      kind: 'network',
      message: '429 Too Many Requests: retry after 5',
    });
    expect(classifyTelegramError(new HttpError("Network request for 'getMe' failed!", new Error('getaddrinfo ENOTFOUND api.telegram.org')))).toEqual({
      kind: 'network',
      message: 'getaddrinfo ENOTFOUND api.telegram.org',
    });
    expect(classifyTelegramError(new Error('socket hang up'))).toEqual({ kind: 'network', message: 'socket hang up' });
  });
});

describe('checkTokenWithTelegram', () => {
  it('returns the bot username or the classified failure', async () => {
    await expect(checkTokenWithTelegram('t', () => Promise.resolve({ username: 'test_bot' }))).resolves.toEqual({ kind: 'valid', username: 'test_bot' });
    await expect(checkTokenWithTelegram('t', () => Promise.reject(apiError(401, 'Unauthorized')))).resolves.toEqual({
      kind: 'invalid',
      message: '401 Unauthorized',
    });
  });
});
