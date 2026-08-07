import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 30,
        branches: 18,
        functions: 25,
        lines: 30,
      },
    },
  },
});
