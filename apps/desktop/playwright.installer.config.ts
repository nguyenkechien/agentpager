import { defineConfig } from '@playwright/test';

/** Installer smoke on the `npm run dist` output: the NSIS installer on Windows, the disk image on macOS. */
export default defineConfig({
  testDir: 'tests/installer',
  testMatch: process.platform === 'win32' ? 'windowsInstaller.smoke.ts' : 'macDmg.smoke.ts',
  // Each step has its own timeout; the test limit only has to exceed their sum, so the slow step shows in the log.
  timeout: 600_000,
  // The list reporter prints the tests' progress lines as they run.
  reporter: 'list',
  workers: 1,
});
