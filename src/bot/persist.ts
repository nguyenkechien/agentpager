import type { BotDeps } from './deps.js';

/**
 * Persists state after a command. In-memory state stays authoritative when the disk write fails:
 * the error is logged and the store retries on the next flush, so the user still gets a reply.
 */
export async function persistState(deps: Pick<BotDeps, 'store' | 'logger'>): Promise<void> {
  try {
    await deps.store.flush();
  } catch (error) {
    deps.logger.error({ err: error }, 'state not persisted yet; it will be retried on the next flush');
  }
}
