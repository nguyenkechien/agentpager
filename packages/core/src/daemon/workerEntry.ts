import { GrammyError } from 'grammy';
import { z } from 'zod';
import { ConfigError } from '../core/config/schema.js';
import { GuardRulesError } from '../core/guard/policy.js';
import { startWorker, type WorkerHandle } from '../core/worker.js';
import { appPaths, currentPlatform } from '../platform/paths.js';
import { LockHeldError } from '../util/lock.js';
import { findPackageRoot } from './packageRoot.js';
import type { WorkerToSupervisor } from './supervisor.js';

const supervisorMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown') }),
  z.object({ type: z.literal('reload-users') }),
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Errors a restart cannot fix: the supervisor stops instead of restart-looping. */
export function fatalMessage(error: unknown): string | null {
  if (error instanceof ConfigError || error instanceof GuardRulesError) return error.message;
  if (error instanceof LockHeldError) return error.message;
  if (error instanceof GrammyError && error.error_code === 401) return 'Token Telegram không hợp lệ (401 Unauthorized)';
  return null;
}

function send(message: WorkerToSupervisor): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('agentpager worker must be started by the supervisor'));
      return;
    }
    process.send(message, undefined, {}, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function exitWithError(context: string, error: unknown): never {
  console.error(`agentpager worker: ${context}:`, error);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!process.send) throw new Error('agentpager worker must be started by the supervisor');

  let handle: WorkerHandle | null = null;
  const lifecycle = { shutdownRequested: false };
  const shutdown = async (): Promise<void> => {
    lifecycle.shutdownRequested = true;
    if (!handle) return;
    await handle.shutdown();
    process.exit(0);
  };

  // Registered before startup so a shutdown sent while the bot is still starting is not lost.
  process.on('message', (raw) => {
    const parsed = supervisorMessageSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('agentpager worker: ignored unknown supervisor message');
      return;
    }
    if (parsed.data.type === 'shutdown') {
      shutdown().catch((error: unknown) => {
        exitWithError('shutdown failed', error);
      });
    } else {
      handle?.reloadUsers().catch((error: unknown) => {
        console.error('agentpager worker: reloading users failed:', error);
      });
    }
  });
  // The supervisor is gone (killed or crashed): stop instead of running orphaned.
  process.on('disconnect', () => {
    shutdown().catch((error: unknown) => {
      exitWithError('shutdown after supervisor disconnect failed', error);
    });
  });
  process.on('unhandledRejection', (reason) => {
    exitWithError('unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    exitWithError('uncaught exception', error);
  });

  const platform = currentPlatform();
  try {
    handle = await startWorker({
      paths: appPaths(platform),
      platform,
      packageRoot: findPackageRoot(import.meta.dirname),
      onActivity: (activity) => {
        send({ type: 'activity', ...activity }).catch((error: unknown) => {
          // The supervisor may be gone already; the disconnect handler stops this worker.
          console.error('agentpager worker: reporting activity failed:', error);
        });
      },
    });
  } catch (error) {
    const fatal = fatalMessage(error);
    if (fatal !== null) {
      await send({ type: 'fatal', message: fatal });
      process.exit(1);
    }
    exitWithError('startup failed', error);
  }

  handle.done.catch((error: unknown) => {
    exitWithError(`Telegram polling failed: ${messageOf(error)}`, error);
  });
  await send({ type: 'ready', botUsername: handle.botUsername, provider: handle.provider });
  if (lifecycle.shutdownRequested) await shutdown();
}

main().catch((error: unknown) => {
  exitWithError('worker crashed', error);
});
