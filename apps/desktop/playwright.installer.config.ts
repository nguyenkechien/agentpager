import { defineConfig } from '@playwright/test';

/** Installer smoke on the `npm run dist` output: the NSIS installer on Windows, the disk image on macOS. */
export default defineConfig({
  testDir: 'tests/installer',
  testMatch: process.platform === 'win32' ? 'windowsInstaller.smoke.ts' : 'macDmg.smoke.ts',
  timeout: 240_000,
  workers: 1,
});
