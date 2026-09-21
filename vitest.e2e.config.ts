import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/e2e/**/*.e2e.test.ts'],
    setupFiles: ['src/__tests__/e2e/setup.ts'],
    // The files share one database, and the webhook delivery queue is global (any test that processes due deliveries handles
    // every pending one), so files run one after another rather than interfering with each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Only used by the combined coverage gate (scripts/coverage-gate.mjs): `--coverage` on this config records what the
    // real-database tests execute, and that is merged with the unit run's figures.
    coverage: { provider: 'v8', exclude: ['src/__tests__/**', ...coverageConfigDefaults.exclude] },
  },
});
