import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      exclude: ['**/*.test.ts', '**/__tests__/**'],
    },
    environment: 'node',
    globals: true,
  },
});
