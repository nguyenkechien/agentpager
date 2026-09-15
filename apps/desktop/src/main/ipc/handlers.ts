import type { ApiResult } from '../../shared/api.js';
import type { InvokeChannel } from '../../shared/channels.js';
import { ok, toApiError } from '../services/results.js';
import { INVOKE_ARGS, type InvokeArgs } from './schemas.js';

/** The parts of Electron's invoke event the handlers use. */
export interface InvokeEventLike {
  senderFrame: { url: string } | null;
  sender: { id: number; send: (channel: string, ...args: unknown[]) => void };
}

export interface IpcMainLike {
  handle: (channel: string, listener: (event: InvokeEventLike, ...args: unknown[]) => Promise<unknown>) => void;
}

/** Which window called, so pushes (log lines) go back to it. */
export interface CallerContext {
  senderId: number;
  send: (channel: string, payload: unknown) => void;
}

export type MainHandlers = {
  [C in InvokeChannel]: (caller: CallerContext, ...args: InvokeArgs<C>) => unknown;
};

export const UNTRUSTED_SENDER_MESSAGE = 'The request did not come from an agentpager window.';

export function registerHandlers(ipc: IpcMainLike, handlers: MainHandlers, isTrustedUrl: (url: string) => boolean): void {
  for (const channel of Object.keys(INVOKE_ARGS) as InvokeChannel[]) {
    ipc.handle(channel, async (event, ...rawArgs): Promise<ApiResult<unknown>> => {
      const frame = event.senderFrame;
      if (frame === null || !isTrustedUrl(frame.url)) {
        return { ok: false, error: { code: 'unauthorized', message: UNTRUSTED_SENDER_MESSAGE } };
      }
      const parsed = INVOKE_ARGS[channel].safeParse(rawArgs);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(args)'}: ${issue.message}`).join('; ');
        return { ok: false, error: { code: 'invalid_input', message: `Invalid request data (${channel}): ${detail}` } };
      }
      const caller: CallerContext = {
        senderId: event.sender.id,
        send: (pushChannel, payload) => {
          event.sender.send(pushChannel, payload);
        },
      };
      try {
        const handler = handlers[channel] as (caller: CallerContext, ...args: unknown[]) => unknown;
        return ok(await handler(caller, ...parsed.data));
      } catch (error) {
        return { ok: false, error: toApiError(error) };
      }
    });
  }
}
