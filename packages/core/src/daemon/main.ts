import { fork } from 'node:child_process';
import { extname, join } from 'node:path';
import pino, { type Logger } from 'pino';
import { z } from 'zod';
import type { AppPaths, PlatformInfo } from '../platform/paths.js';
import { newToken, readDaemonInfo, removeDaemonInfo, writeDaemonInfo, type DaemonLauncher } from './daemonInfo.js';
import { IpcError, ipcRequest, startIpcServer, type IpcCommand } from './ipc.js';
import { readPackageVersion } from './packageRoot.js';
import { Supervisor, type WorkerProcess, type WorkerToSupervisor } from './supervisor.js';

export interface RunDaemonOptions {
  paths: AppPaths;
  platform: PlatformInfo;
  packageRoot: string;
  /** Mirror logs and worker output to this terminal instead of running detached. */
  foreground: boolean;
  /** Recorded in daemon.json so a UI can show where the running bot came from. */
  launcher: DaemonLauncher;
  /** Extra environment for the forked worker (the desktop app sets ELECTRON_RUN_AS_NODE). */
  workerEnv?: Record<string, string>;
}

const EXISTING_DAEMON_PING_TIMEOUT_MS = 2_000;

const workerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), botUsername: z.string(), provider: z.string() }),
  z.object({ type: z.literal('fatal'), message: z.string() }),
  z.object({ type: z.literal('activity'), activeTurns: z.number().int().nonnegative(), queuedInputs: z.number().int().nonnegative() }),
]);

function createSupervisorLogger(paths: AppPaths, foreground: boolean): Logger {
  const streams: pino.StreamEntry[] = [
    // Synchronous: the supervisor logs rarely, and its last lines must survive an immediate process exit.
    { stream: pino.destination({ dest: join(paths.logs, 'supervisor.log'), mkdir: true, sync: true }) },
  ];
  if (foreground) streams.push({ stream: process.stdout });
  return pino({ level: 'info', base: { component: 'supervisor' } }, pino.multistream(streams));
}

function forkWorker(options: RunDaemonOptions, logger: Logger): WorkerProcess {
  // Same folder as this file in both src/ (tsx) and dist/.
  const entry = join(import.meta.dirname, `workerEntry${extname(import.meta.filename)}`);
  const execArgv = ['--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED', ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : [])];
  // ForkOptions' typings omit windowsHide, but fork() hands every option to spawn(); without it a console
  // window can flash on Windows when the hidden daemon starts a worker.
  const forkOptions = {
    execArgv,
    stdio: options.foreground ? ('inherit' as const) : ('ignore' as const),
    windowsHide: true,
    env: { ...process.env, AGENTPAGER_HOME: options.paths.root, ...options.workerEnv },
  };
  const child = fork(entry, [], forkOptions);
  child.on('error', (error) => {
    logger.error({ err: error }, 'worker process error');
  });
  return {
    get pid() {
      return child.pid;
    },
    send: (message) => {
      if (!child.connected) {
        logger.warn({ message }, 'worker channel is closed; message not delivered');
        return;
      }
      child.send(message, (error) => {
        if (error) logger.warn({ err: error, message }, 'failed to deliver message to worker');
      });
    },
    onMessage: (listener) => {
      child.on('message', (raw) => {
        const parsed = workerMessageSchema.safeParse(raw);
        const message: WorkerToSupervisor | null = parsed.success ? parsed.data : null;
        if (message) listener(message);
        else logger.warn('ignored unknown worker message');
      });
    },
    onExit: (listener) => {
      child.on('exit', (code) => {
        listener(code);
      });
    },
    kill: () => {
      child.kill();
    },
  };
}

/** Returns a message when another daemon already answers on the recorded endpoint. */
async function runningDaemonProblem(paths: AppPaths): Promise<string | null> {
  const existing = await readDaemonInfo(paths.daemonInfo);
  if (!existing) return null;
  try {
    await ipcRequest(existing, 'ping', EXISTING_DAEMON_PING_TIMEOUT_MS);
    return `agentpager đang chạy (pid ${existing.pid})`;
  } catch (error) {
    if (!(error instanceof IpcError)) throw error;
    if (error.code === 'not_running') return null;
    return `Có tiến trình agentpager khác đang giữ IPC (pid ${existing.pid}): ${error.message}`;
  }
}

/** Runs the supervisor until it is stopped or hits a fatal worker error; resolves with the exit code. */
export async function runDaemon(options: RunDaemonOptions): Promise<number> {
  const logger = createSupervisorLogger(options.paths, options.foreground);
  try {
    return await supervise(options, logger);
  } catch (error) {
    // Detached launches (CLI spawn, autostart, desktop app) have no terminal: the log is the only trace.
    logger.error({ err: error }, 'daemon failed');
    throw error;
  }
}

async function supervise(options: RunDaemonOptions, logger: Logger): Promise<number> {
  const { paths, platform } = options;

  const problem = await runningDaemonProblem(paths);
  if (problem) {
    logger.error(problem);
    return 1;
  }

  const version = await readPackageVersion(options.packageRoot);
  const token = newToken();
  const supervisor = new Supervisor({ spawnWorker: () => forkWorker(options, logger), now: Date.now, logger, pid: process.pid });

  const handle = (command: IpcCommand): Promise<unknown> => {
    switch (command) {
      case 'ping':
        return Promise.resolve({ version });
      case 'status':
        return Promise.resolve(supervisor.status());
      case 'stop':
        // Answer first: a graceful stop can take longer than the client's request timeout.
        setImmediate(() => {
          void supervisor.stop();
        });
        return Promise.resolve({ stopping: true });
      case 'restart':
        supervisor.restart().catch((error: unknown) => {
          logger.error({ err: error }, 'restart failed');
        });
        return Promise.resolve({ restarting: true });
      case 'reload-users':
        supervisor.reloadUsers();
        return Promise.resolve({ reloaded: true });
    }
  };

  const server = await startIpcServer({ path: paths.ipc, token, platform: platform.platform, logger, handle });
  await writeDaemonInfo(
    paths.daemonInfo,
    { pid: process.pid, startedAt: new Date().toISOString(), ipc: { path: paths.ipc }, token, launcher: options.launcher },
    platform.platform,
  );

  const finished = new Promise<'stopped' | 'fatal'>((resolve) => {
    supervisor.onFinished(resolve);
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'signal received; stopping');
    void supervisor.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  supervisor.start();
  const reason = await finished;

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await server.close();
  await removeDaemonInfo(paths.daemonInfo);
  logger.info({ reason }, 'daemon exited');
  return reason === 'fatal' ? 1 : 0;
}
