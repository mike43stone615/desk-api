import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        // Raised from 30/18/25/30 to sit with real margin below actual
        // coverage (64/53/68/67% at the time of this change) rather than
        // only catching a catastrophic regression -- the old floor was low
        // enough that coverage could have dropped by roughly half before
        // this gate ever noticed.
        statements: 55,
        branches: 45,
        functions: 60,
        lines: 60,
      },
    },
  },
});
