import { Api, GrammyError, HttpError } from 'grammy';
import type { TokenCheck } from './configService.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Telegram refusing the token and Telegram being unreachable need different answers in the wizard. */
export function classifyTelegramError(error: unknown): TokenCheck {
  if (error instanceof GrammyError) {
    // getMe answers 401 Unauthorized (revoked or wrong secret) or 404 Not Found (no such bot) for a bad token.
    if (error.error_code === 401 || error.error_code === 404) {
      return { kind: 'invalid', message: `${String(error.error_code)} ${error.description}` };
    }
    return { kind: 'network', message: `${String(error.error_code)} ${error.description}` };
  }
  if (error instanceof HttpError) return { kind: 'network', message: messageOf(error.error) };
  return { kind: 'network', message: messageOf(error) };
}

export async function checkTokenWithTelegram(
  token: string,
  getMe: (token: string) => Promise<{ username: string }> = (value) => new Api(value).getMe(),
): Promise<TokenCheck> {
  try {
    const me = await getMe(token);
    return { kind: 'valid', username: me.username };
  } catch (error) {
    return classifyTelegramError(error);
  }
}
