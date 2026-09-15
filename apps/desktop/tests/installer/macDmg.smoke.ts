import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/** The built disk image for this machine's architecture, copied out like a user would, then run from the copy. */

const releaseDir = join(import.meta.dirname, '..', '..', 'release');
const work = mkdtempSync(join(tmpdir(), 'agentpager-dmg-'));
const appBundle = join(work, 'Applications', 'agentpager.app');
const executable = join(appBundle, 'Contents', 'MacOS', 'agentpager');

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)}): ${result.stderr}`);
  return result.stdout;
}

/** This environment with a temporary AGENTPAGER_HOME; ELECTRON_RUN_AS_NODE would start the app as plain Node. */
function testEnv(home: string): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...process.env, AGENTPAGER_HOME: home }).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE'));
}

test.describe.configure({ mode: 'serial' });

test('the disk image holds an ad-hoc signed app that verifies', () => {
  const pattern = new RegExp(`^agentpager-.+-${process.arch}\\.dmg$`);
  const dmg = readdirSync(releaseDir).find((name) => pattern.test(name));
  if (dmg === undefined) throw new Error(`no ${process.arch} disk image in ${releaseDir}`);
  const mount = join(work, 'mnt');
  mkdirSync(mount);
  run('hdiutil', ['attach', join(releaseDir, dmg), '-nobrowse', '-readonly', '-mountpoint', mount]);
  try {
    mkdirSync(join(work, 'Applications'));
    run('ditto', [join(mount, 'agentpager.app'), appBundle]);
  } finally {
    run('hdiutil', ['detach', mount]);
  }
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
});

test('the copied app opens the wizard', async () => {
  const app = await electron.launch({ executablePath: executable, env: testEnv(mkdtempSync(join(tmpdir(), 'agentpager-dmg-home-'))) });
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'Set up agentpager' })).toBeVisible();
  await app.close();
});

test('the copied app forks the bot worker and carries a working Claude Code binary', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentpager-dmg-daemon-'));
  const daemon = spawnSync(executable, ['--daemon'], { env: testEnv(home), timeout: 60_000 });
  expect(daemon.status).toBe(1);
  expect(readFileSync(join(home, 'logs', 'supervisor.log'), 'utf8')).toContain('No config yet');

  const claude = join(appBundle, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${process.arch}`, 'claude');
  expect(run(claude, ['--version'])).toMatch(/Claude Code/);
});
