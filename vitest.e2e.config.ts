import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/e2e/**/*.e2e.test.ts'],
    setupFiles: ['src/__tests__/e2e/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
