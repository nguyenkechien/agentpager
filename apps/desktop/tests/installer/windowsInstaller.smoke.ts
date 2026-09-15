import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Kept inside the app folder so release.yml uploads its logs (supervisor.log, desktop.log) when a test fails.
const homesDir = join(import.meta.dirname, '..', '..', 'installer-smoke-home');
mkdirSync(homesDir, { recursive: true });
const home = mkdtempSync(join(homesDir, 'run-'));
const started = Date.now();

/** Timestamped progress, so a slow or stuck step is visible in the CI log. */
function step(message: string): void {
  console.log(`[installer smoke +${String(Math.round((Date.now() - started) / 1000))}s] ${message}`);
}
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
  step(`running ${setup} /S`);
  const result = spawnSync(join(releaseDir, setup), ['/S'], { env, stdio: 'inherit' });
  step(`installer exited ${String(result.status)}`);
  expect(result.status).toBe(0);
  await expect.poll(() => existsSync(installedExe), { timeout: 60_000 }).toBe(true);
  expect(existsSync(startMenuShortcut)).toBe(true);
  step('installed');
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
  step(`starting the installed daemon with AGENTPAGER_HOME=${home}`);
  const daemon = spawn(installedExe, ['--daemon'], { env, stdio: 'ignore', detached: true });
  daemon.unref();
  await expect.poll(daemonAnswers, { timeout: 30_000 }).toBe(true);
  step('daemon answers');

  step('running --prepare-update');
  const prepare = spawnSync(installedExe, ['--prepare-update'], { env, timeout: 90_000, encoding: 'utf8' });
  step(
    `--prepare-update exited ${String(prepare.status)} (signal ${String(prepare.signal)}, error ${prepare.error?.message ?? 'none'}); ` +
      `stdout: ${prepare.stdout.trim() || '-'}; stderr: ${prepare.stderr.trim() || '-'}`,
  );
  expect(prepare.status).toBe(0);
  expect(existsSync(join(home, 'update-resume.json'))).toBe(true);
  expect(readFileSync(join(home, 'logs', 'supervisor.log'), 'utf8')).toContain('supervisor finished');
  await expect.poll(() => existsSync(daemonInfoFile), { timeout: 30_000 }).toBe(false);
  step('daemon stopped by --prepare-update');

  // The next start of the app (the installer runs it after an update) picks the marker up and starts the bot.
  step('launching the installed GUI');
  const app = await electron.launch({ executablePath: installedExe, env, timeout: 60_000 });
  step('GUI launched');
  await expect.poll(daemonAnswers, { timeout: 60_000 }).toBe(true);
  step('daemon answers again');
  await expect.poll(() => existsSync(join(home, 'update-resume.json')), { timeout: 10_000 }).toBe(false);

  // Stop the bot before closing the app. On Windows the daemon the app started inherits the app's stdio pipes, and
  // Playwright's close() waits until those pipes close: with the daemon still running it waits forever (seen on CI:
  // the app had exited, the daemon kept retrying for 16 minutes).
  step('stopping the daemon started by the GUI');
  await ipc('stop');
  await expect.poll(() => existsSync(daemonInfoFile), { timeout: 30_000 }).toBe(false);
  step('daemon stopped');
  step('closing the GUI');
  await app.close();
  step('GUI closed');
});

test('uninstalls the app and its window profile but keeps the bot data', async () => {
  mkdirSync(join(appData, 'agentpager'), { recursive: true });
  writeFileSync(botDataSentinel, 'kept', 'utf8');
  // With AGENTPAGER_HOME the app keeps its profile in that folder; stand in for the real profile of an installed app.
  mkdirSync(chromiumProfile, { recursive: true });
  writeFileSync(join(chromiumProfile, 'Preferences'), '{}', 'utf8');
  step('running the uninstaller /S');
  const result = spawnSync(join(installDir, 'Uninstall agentpager.exe'), ['/S'], { env, stdio: 'inherit' });
  step(`uninstaller exited ${String(result.status)}`);
  expect(result.status).toBe(0);
  // The uninstaller copies itself to a temporary folder and finishes there.
  await expect.poll(() => existsSync(installedExe), { timeout: 120_000 }).toBe(false);
  await expect.poll(() => existsSync(chromiumProfile), { timeout: 30_000 }).toBe(false);
  expect(existsSync(startMenuShortcut)).toBe(false);
  expect(readFileSync(botDataSentinel, 'utf8')).toBe('kept');
});
