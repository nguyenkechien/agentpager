import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcError, ipcRequest, readDaemonInfo } from '@chiennguyen/agentpager/daemon';
import { _electron as electron, expect, test } from '@playwright/test';

const releaseDir = join(import.meta.dirname, '..', '..', 'release');

/** AGENTPAGER_EXE points the smoke at another build of the app, e.g. an installed copy. */
function packagedExecutable(): string {
  const override = process.env.AGENTPAGER_EXE;
  if (override !== undefined && override !== '') return override;
  if (process.platform === 'win32') return join(releaseDir, 'win-unpacked', 'agentpager.exe');
  const macDir = readdirSync(releaseDir).find((name) => name.startsWith('mac'));
  if (!macDir) throw new Error(`no mac build in ${releaseDir}`);
  return join(releaseDir, macDir, 'agentpager.app', 'Contents', 'MacOS', 'agentpager');
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'agentpager-smoke-'));
}

function runDaemonProcess(home: string): Promise<number | null> {
  const child = spawn(packagedExecutable(), ['--daemon'], { env: { ...process.env, AGENTPAGER_HOME: home }, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code);
    });
  });
}

function workerLogFiles(home: string): string[] {
  const logsDir = join(home, 'logs');
  return existsSync(logsDir) ? readdirSync(logsDir).filter((name) => name.startsWith('agentpager.')) : [];
}

test('the packaged app opens the wizard through the preload bridge when there is no config', async () => {
  const app = await electron.launch({ executablePath: packagedExecutable(), env: { ...process.env, AGENTPAGER_HOME: tempHome() } });
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'Thiết lập agentpager' })).toBeVisible();
  await expect(window.getByLabel('Token')).toBeVisible();
  await app.close();
});

test('--daemon without a config forks the worker, logs the fatal error, exits 1 and removes daemon.json', async () => {
  const home = tempHome();
  expect(await runDaemonProcess(home)).toBe(1);
  const supervisorLog = readFileSync(join(home, 'logs', 'supervisor.log'), 'utf8');
  expect(supervisorLog).toContain('worker reported a fatal error');
  expect(supervisorLog).toContain('Chưa có cấu hình');
  expect(existsSync(join(home, 'daemon.json'))).toBe(false);
});

test('--daemon with a config runs the worker logger (pino-roll transport) from the packaged app', async () => {
  const home = tempHome();
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      telegram: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVwxyz' },
      allowedUsers: [{ username: 'example_user', userId: null, pairedAt: null }],
      projectsRoot: home,
      idleTimeoutMinutes: 60,
      logLevel: 'info',
      agent: { provider: 'claude-code', executable: null, defaultModel: null, defaultEffort: null },
    }),
  );
  const exited = runDaemonProcess(home);
  await expect.poll(() => workerLogFiles(home).length, { timeout: 30_000 }).toBeGreaterThan(0);

  // The fake token makes Telegram answer 401 (fatal, exit 1). Without network the worker keeps restarting,
  // so stop it through IPC; a daemon that already exited on the 401 answers not_running.
  const info = await readDaemonInfo(join(home, 'daemon.json'));
  if (info) {
    await ipcRequest(info, 'stop').catch((error: unknown) => {
      if (!(error instanceof IpcError && error.code === 'not_running')) throw error;
    });
  }
  expect([0, 1]).toContain(await exited);
});
