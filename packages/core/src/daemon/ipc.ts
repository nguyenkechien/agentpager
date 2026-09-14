import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { DaemonInfo } from './daemonInfo.js';

export const IPC_COMMANDS = ['ping', 'status', 'stop', 'restart', 'reload-users'] as const;
export type IpcCommand = (typeof IPC_COMMANDS)[number];

export interface IpcResponse {
  id: string | null;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const DEFAULT_IPC_TIMEOUT_MS = 5_000;
const MAX_LINE_LENGTH = 64 * 1024;

const requestSchema = z.object({ id: z.string().min(1), token: z.string(), cmd: z.string() });

export type IpcErrorCode = 'not_running' | 'timeout' | 'unauthorized' | 'failed';

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

function isCommand(value: string): value is IpcCommand {
  return (IPC_COMMANDS as readonly string[]).includes(value);
}

function tokensMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface IpcServerOptions {
  path: string;
  token: string;
  platform: NodeJS.Platform;
  logger: Logger;
  handle(command: IpcCommand): Promise<unknown>;
}

async function respond(line: string, options: IpcServerOptions): Promise<IpcResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // Not JSON at all: answer with a protocol error instead of dropping the connection silently.
    options.logger.warn('ipc request is not valid JSON');
    return { id: null, ok: false, error: 'bad_request' };
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    options.logger.warn('ipc request has an invalid shape');
    return { id: null, ok: false, error: 'bad_request' };
  }
  const { id, token, cmd } = parsed.data;
  if (!tokensMatch(options.token, token)) {
    options.logger.warn({ cmd }, 'ipc request rejected: wrong token');
    return { id, ok: false, error: 'unauthorized' };
  }
  if (!isCommand(cmd)) return { id, ok: false, error: 'unknown_command' };
  try {
    return { id, ok: true, data: await options.handle(cmd) };
  } catch (error) {
    options.logger.error({ err: error, cmd }, 'ipc command failed');
    return { id, ok: false, error: messageOf(error) };
  }
}

function serveConnection(socket: Socket, options: IpcServerOptions): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_LENGTH && !buffer.includes('\n')) {
      options.logger.warn('ipc request line too long; closing connection');
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        void respond(line, options).then((response) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
        });
      }
      newline = buffer.indexOf('\n');
    }
  });
  socket.on('error', (error) => {
    options.logger.debug({ err: error }, 'ipc client connection error');
  });
}

/** Newline-delimited JSON over a named pipe (Windows) or unix socket. */
export async function startIpcServer(options: IpcServerOptions): Promise<{ close(): Promise<void> }> {
  if (options.platform !== 'win32') {
    await mkdir(dirname(options.path), { recursive: true });
    // A socket file left by a crashed daemon blocks listen(); callers check that no daemon answers first.
    await rm(options.path, { force: true });
  }

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => {
    options.logger.error({ err: error }, 'ipc server error');
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

export function ipcRequest(info: DaemonInfo | null, command: IpcCommand, timeoutMs = DEFAULT_IPC_TIMEOUT_MS): Promise<unknown> {
  if (!info) return Promise.reject(new IpcError('not_running', 'agentpager không chạy'));

  return new Promise<unknown>((resolve, reject) => {
    const id = randomUUID();
    const socket = connect(info.ipc.path);
    let buffer = '';
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new IpcError('timeout', `Daemon không phản hồi sau ${timeoutMs} ms`));
      });
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, token: info.token, cmd: command })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response: IpcResponse;
      try {
        response = JSON.parse(buffer.slice(0, newline)) as IpcResponse;
      } catch (error) {
        finish(() => {
          reject(new IpcError('failed', `Phản hồi IPC không hợp lệ: ${messageOf(error)}`));
        });
        return;
      }
      finish(() => {
        if (response.ok) resolve(response.data);
        else if (response.error === 'unauthorized') reject(new IpcError('unauthorized', 'Token IPC không khớp — daemon.json đã cũ?'));
        else reject(new IpcError('failed', `Daemon báo lỗi: ${response.error ?? 'không rõ'}`));
      });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') reject(new IpcError('not_running', 'agentpager không chạy'));
        else reject(new IpcError('failed', `IPC lỗi: ${error.message}`));
      });
    });
    socket.on('close', () => {
      finish(() => {
        reject(new IpcError('failed', 'Daemon đóng kết nối mà không trả lời'));
      });
    });
  });
}
