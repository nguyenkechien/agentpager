import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonStatus } from '@chiennguyen/agentpager/control';
import { ipcRequest, readDaemonInfo, type IpcCommand } from '@chiennguyen/agentpager/daemon';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * Installs the built NSIS installer into this Windows user profile, exercises the update and uninstall hooks, and
 * removes it again. CI only: on a developer machine it would replace a real installation.
 *
 * The runner blocks api.telegram.org (release.yml) so the bot worker keeps retrying and the daemon stays up.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const releaseDir = join(import.meta.dirname, '..', '..', 'release');
const appData = requiredEnv('APPDATA');
const installDir = join(requiredEnv('LOCALAPPDATA'), 'Programs', 'agentpager');
const installedExe = join(installDir, 'agentpager.exe');
const startMenuShortcut = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'agentpager.lnk');
const chromiumProfile = join(appData, 'agentpager-desktop');
const botDataSentinel = join(appData, 'agentpager', 'installer-smoke.txt');

const home = mkdtempSync(join(tmpdir(), 'agentpager-installer-'));
/** This environment with a temporary AGENTPAGER_HOME; ELECTRON_RUN_AS_NODE would start the app as plain Node. */
const env: Record<string, string> = Object.fromEntries(
  Object.entries({ ...process.env, AGENTPAGER_HOME: home }).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE'),
);

const daemonInfoFile = join(home, 'daemon.json');

async function ipc(command: IpcCommand): Promise<unknown> {
  return ipcRequest(await readDaemonInfo(daemonInfoFile), command);
}

function daemonAnswers(): Promise<boolean> {
  return readDaemonStatus({ ipc }).then(
    (status) => status !== null,
    () => false,
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (process.env.CI !== 'true') {
    throw new Error('The installer smoke installs into this user profile and removes it again: it only runs on CI (CI=true).');
  }
});

test('installs silently for the current user', async () => {
  const setup = readdirSync(releaseDir).find((name) => /^agentpager-Setup-.+\.exe$/.test(name));
  if (setup === undefined) throw new Error(`no installer in ${releaseDir}`);
  const result = spawnSync(join(releaseDir, setup), ['/S'], { env, stdio: 'inherit' });
  expect(result.status).toBe(0);
  await expect.poll(() => existsSync(installedExe), { timeout: 60_000 }).toBe(true);
  expect(existsSync(startMenuShortcut)).toBe(true);
});

test('stops a bot running from the installation before an update and starts it again afterwards', async () => {
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
  const daemon = spawn(installedExe, ['--daemon'], { env, stdio: 'ignore', detached: true });
  daemon.unref();
  await expect.poll(daemonAnswers, { timeout: 30_000 }).toBe(true);

  const prepare = spawnSync(installedExe, ['--prepare-update'], { env, timeout: 90_000 });
  expect(prepare.status).toBe(0);
  expect(existsSync(join(home, 'update-resume.json'))).toBe(true);
  expect(readFileSync(join(home, 'logs', 'supervisor.log'), 'utf8')).toContain('supervisor finished');
  await expect.poll(() => existsSync(daemonInfoFile), { timeout: 30_000 }).toBe(false);

  // The next start of the app (the installer runs it after an update) picks the marker up and starts the bot.
  const app = await electron.launch({ executablePath: installedExe, env });
  await expect.poll(daemonAnswers, { timeout: 60_000 }).toBe(true);
  await expect.poll(() => existsSync(join(home, 'update-resume.json')), { timeout: 10_000 }).toBe(false);
  await app.close();

  await ipc('stop');
  await expect.poll(() => existsSync(daemonInfoFile), { timeout: 30_000 }).toBe(false);
});

test('uninstalls the app and its window profile but keeps the bot data', async () => {
  mkdirSync(join(appData, 'agentpager'), { recursive: true });
  writeFileSync(botDataSentinel, 'kept', 'utf8');
  // With AGENTPAGER_HOME the app keeps its profile in that folder; stand in for the real profile of an installed app.
  mkdirSync(chromiumProfile, { recursive: true });
  writeFileSync(join(chromiumProfile, 'Preferences'), '{}', 'utf8');
  const result = spawnSync(join(installDir, 'Uninstall agentpager.exe'), ['/S'], { env, stdio: 'inherit' });
  expect(result.status).toBe(0);
  // The uninstaller copies itself to a temporary folder and finishes there.
  await expect.poll(() => existsSync(installedExe), { timeout: 120_000 }).toBe(false);
  await expect.poll(() => existsSync(chromiumProfile), { timeout: 30_000 }).toBe(false);
  expect(existsSync(startMenuShortcut)).toBe(false);
  expect(readFileSync(botDataSentinel, 'utf8')).toBe('kept');
});
