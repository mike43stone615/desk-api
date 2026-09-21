import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        // Raised in September 2026 (was 55/45/60/60). Set to 70/60/70/72 after the platform features landed: their real-database
        // tests (src/__tests__/e2e) run in a separate CI step, so the unit-run figure (about 75%) does not count them.
        // Raised from 30/18/25/30 to sit with real margin below actual
        // coverage (64/53/68/67% at the time of this change) rather than
        // only catching a catastrophic regression -- the old floor was low
        // enough that coverage could have dropped by roughly half before
        // this gate ever noticed.
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 72,
      },
    },
  },
});
