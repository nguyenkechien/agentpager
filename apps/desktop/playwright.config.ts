import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: 'tests/smoke', testMatch: '*.smoke.ts', timeout: 90_000, workers: 1 });
