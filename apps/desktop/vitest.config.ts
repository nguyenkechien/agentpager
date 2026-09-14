import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'main', include: ['tests/main/**/*.test.ts'], environment: 'node' } },
      {
        plugins: [react()],
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
