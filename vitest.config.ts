import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      // Test helpers are not product code; counting them only inflates the figure.
      exclude: ['src/__tests__/**', ...coverageConfigDefaults.exclude],
      thresholds: {
        // This is the floor for the unit run alone (the deploy workflow has no database, so it cannot run the real-database tests).
        // The stricter combined gate, unit + real-database tests merged, is scripts/coverage-gate.mjs (run by the test workflow).
        // Measured 73/66/74/76 in September 2026 after the test helpers were left out of the count.
        // Raised from 30/18/25/30 to sit with real margin below actual
        // coverage (64/53/68/67% at the time of this change) rather than
        // only catching a catastrophic regression -- the old floor was low
        // enough that coverage could have dropped by roughly half before
        // this gate ever noticed.
        statements: 72,
        branches: 64,
        functions: 72,
        lines: 74,
      },
    },
  },
});
