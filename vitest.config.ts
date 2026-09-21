import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        // Raised again in September 2026 (was 55/45/60/60) to sit below actual coverage (82/74/83/84%).
        // Raised from 30/18/25/30 to sit with real margin below actual
        // coverage (64/53/68/67% at the time of this change) rather than
        // only catching a catastrophic regression -- the old floor was low
        // enough that coverage could have dropped by roughly half before
        // this gate ever noticed.
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 77,
      },
    },
  },
});
