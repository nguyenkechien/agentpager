import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'main', include: ['tests/main/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'renderer',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['tests/renderer/setup.ts'],
        },
      },
    ],
  },
});
