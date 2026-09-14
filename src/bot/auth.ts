import type { MiddlewareFn } from 'grammy';
import type { Logger } from 'pino';

export function isAuthorized(
  update: { fromId: number | undefined; chatType: string | undefined },
  allowed: ReadonlySet<number>,
): boolean {
  return update.fromId !== undefined && allowed.has(update.fromId) && update.chatType === 'private';
}

export function createAuthMiddleware(allowed: ReadonlySet<number>, logger: Logger): MiddlewareFn {
  return async (ctx, next) => {
    if (isAuthorized({ fromId: ctx.from?.id, chatType: ctx.chat?.type }, allowed)) {
      await next();
      return;
    }
    // Unauthorized updates get no reply so the bot does not reveal itself.
    logger.warn(
      { userId: ctx.from?.id, username: ctx.from?.username, chatType: ctx.chat?.type, updateId: ctx.update.update_id },
      'ignored update from unauthorized user or chat',
    );
  };
}
