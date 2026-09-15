import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  newToken,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
  type DaemonInfo,
} from '../../src/daemon/daemonInfo.js';
import { IPC_COMMANDS, IpcError, ipcRequest, startIpcServer, type IpcCommand, type IpcServerOptions } from '../../src/daemon/ipc.js';

let counter = 0;
const closers: (() => Promise<void>)[] = [];

function uniqueIpcPath(): string {
  counter += 1;
  if (process.platform === 'win32') return `\\\\.\\pipe\\agentpager-test-${process.pid}-${counter}-${Date.now()}`;
  return join(mkdtempSync(join(tmpdir(), 'ap-ipc-')), 'ipc.sock');
}

function info(path: string, token: string): DaemonInfo {
  return { pid: process.pid, startedAt: new Date().toISOString(), ipc: { path }, token };
}

async function serve(handle: IpcServerOptions['handle']) {
  const logger = pino({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const path = uniqueIpcPath();
  const token = newToken();
  const server = await startIpcServer({ path, token, platform: process.platform, logger, handle });
  closers.push(() => server.close());
  return { path, token, server, warn };
}

async function expectIpcError(promise: Promise<unknown>, code: IpcError['code']): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(IpcError);
  expect((error as IpcError).code).toBe(code);
}

function rawRequest(path: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
    });
    socket.on('error', reject);
  });
}

beforeEach(() => {
  closers.length = 0;
});

afterEach(async () => {
  for (const close of closers) await close();
});

describe('ipc server and client', () => {
  it('round-trips every command', async () => {
    const { path, token } = await serve((command: IpcCommand) => Promise.resolve({ echoed: command }));
    for (const command of IPC_COMMANDS) {
      await expect(ipcRequest(info(path, token), command)).resolves.toEqual({ echoed: command });
    }
  });

  it('rejects a wrong token and logs it', async () => {
    const { path, warn } = await serve(() => Promise.resolve('secret'));
    await expectIpcError(ipcRequest(info(path, newToken()), 'status'), 'unauthorized');
    expect(warn).toHaveBeenCalledWith({ cmd: 'status' }, 'ipc request rejected: wrong token');
  });

  it('reports a daemon that is not running', async () => {
    await expectIpcError(ipcRequest(null, 'ping'), 'not_running');
    await expectIpcError(ipcRequest(info(uniqueIpcPath(), newToken()), 'ping'), 'not_running');

    const { path, token, server } = await serve(() => Promise.resolve('pong'));
    await server.close();
    closers.pop();
    await expectIpcError(ipcRequest(info(path, token), 'ping'), 'not_running');
  });

  it('times out when the daemon does not answer', async () => {
    const { path, token } = await serve(() => new Promise<never>(() => undefined));
    await expectIpcError(ipcRequest(info(path, token), 'status', 100), 'timeout');
  });

  it('passes handler failures back to the client', async () => {
    const { path, token } = await serve(() => Promise.reject(new Error('worker is gone')));
    const error: unknown = await ipcRequest(info(path, token), 'restart').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({ code: 'failed', message: 'Daemon reported an error: worker is gone' });
  });

  it('answers malformed requests and unknown commands with protocol errors', async () => {
    const { path, token } = await serve(() => Promise.resolve('ok'));
    await expect(rawRequest(path, 'garbage')).resolves.toEqual({ id: null, ok: false, error: 'bad_request' });
    await expect(rawRequest(path, JSON.stringify({ id: 'x', cmd: 'ping' }))).resolves.toEqual({
      id: null,
      ok: false,
      error: 'bad_request',
    });
    await expect(rawRequest(path, JSON.stringify({ id: 'x', token, cmd: 'explode' }))).resolves.toEqual({
      id: 'x',
      ok: false,
      error: 'unknown_command',
    });
  });

  it.runIf(process.platform !== 'win32')('replaces a stale socket file left by a crashed daemon', async () => {
    const path = uniqueIpcPath();
    writeFileSync(path, '');
    const token = newToken();
    const server = await startIpcServer({
      path,
      token,
      platform: process.platform,
      logger: pino({ level: 'silent' }),
      handle: () => Promise.resolve('pong'),
    });
    closers.push(() => server.close());
    await expect(ipcRequest(info(path, token), 'ping')).resolves.toBe('pong');
  });
});

describe('daemon info file', () => {
  let file: string;

  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'ap-daemon-')), 'nested', 'daemon.json');
  });

  it('writes, reads and removes the daemon info', async () => {
    const written = info('\\\\.\\pipe\\agentpager-alex', newToken());
    await writeDaemonInfo(file, written, process.platform);
    await expect(readDaemonInfo(file)).resolves.toEqual(written);
    await removeDaemonInfo(file);
    await expect(readDaemonInfo(file)).resolves.toBeNull();
    await expect(removeDaemonInfo(file)).resolves.toBeUndefined();
  });

  it('treats a missing, corrupt or wrongly shaped file as no daemon', async () => {
    await expect(readDaemonInfo(file)).resolves.toBeNull();
    await writeDaemonInfo(file, info('/tmp/a.sock', newToken()), process.platform);
    writeFileSync(file, '{ torn');
    await expect(readDaemonInfo(file)).resolves.toBeNull();
    writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 'x', ipcPath: '/tmp/a.sock', token: 'short' }));
    await expect(readDaemonInfo(file)).resolves.toBeNull();
  });

  it('stores where the daemon was launched from and still reads files without it', async () => {
    const withLauncher: DaemonInfo = {
      ...info('/tmp/a.sock', newToken()),
      launcher: { kind: 'app', executable: 'C:\\agentpager\\agentpager.exe' },
    };
    await writeDaemonInfo(file, withLauncher, process.platform);
    await expect(readDaemonInfo(file)).resolves.toEqual(withLauncher);

    const withoutLauncher = info('/tmp/a.sock', newToken());
    await writeDaemonInfo(file, withoutLauncher, process.platform);
    await expect(readDaemonInfo(file)).resolves.toEqual(withoutLauncher);

    writeFileSync(file, JSON.stringify({ ...withoutLauncher, launcher: { kind: 'robot', executable: 'x' } }));
    await expect(readDaemonInfo(file)).resolves.toBeNull();
  });

  it.runIf(process.platform !== 'win32')('restricts the file to its owner on POSIX', async () => {
    await writeDaemonInfo(file, info('/tmp/a.sock', newToken()), process.platform);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('creates distinct 32-byte hex tokens', () => {
    const first = newToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(first);
  });
});
