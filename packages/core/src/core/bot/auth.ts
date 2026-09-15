import type { MiddlewareFn } from 'grammy';
import type { Logger } from 'pino';
import { decideAuth, type AllowedUsersSource, type DenyReason } from '../config/allowedUsers.js';

const DENY_LOG: Record<DenyReason, string> = {
  not_private: 'ignored update from a non-private chat',
  unknown_user: 'ignored update from unauthorized user',
  username_paired_to_other_id: 'username matches a paired user with a different id',
};

export function createAuthMiddleware(users: AllowedUsersSource, logger: Logger): MiddlewareFn {
  return async (ctx, next) => {
    const update = { fromId: ctx.from?.id, username: ctx.from?.username, chatType: ctx.chat?.type };
    const meta = { userId: update.fromId, username: update.username, chatType: update.chatType, updateId: ctx.update.update_id };
    const decision = decideAuth(update, users.current());

    switch (decision.kind) {
      case 'allow':
        await next();
        return;
      case 'pair':
        try {
          await users.pair(decision.username, decision.userId);
        } catch (error) {
          logger.error({ ...meta, err: error }, 'failed to pair username; update ignored');
          return;
        }
        logger.info(meta, 'paired username with user id');
        await ctx.reply(`✅ Paired @${decision.username} with agentpager.`);
        await next();
        return;
      case 'deny':
        // Unauthorized updates get no reply so the bot does not reveal itself.
        logger.warn({ ...meta, reason: decision.reason }, DENY_LOG[decision.reason]);
        return;
    }
  };
}
