-- National reference-distribution cache for market-research scoring.
--
-- Two tables, mirroring the oews_wage_rows / oews_import_runs split in
-- 005_oews_cache.sql:
--   * market_reference_values holds the raw per-geography values fetched by
--     the batch job (one row per metric + jurisdiction level + geography).
--   * market_reference_breakpoints holds the *computed* decile breakpoints
--     the scoring code will actually query on the hot path — cheap,
--     single-row lookups, no scanning of the raw table per request.
--   * market_reference_batch_runs tracks batch job executions, mirroring
--     oews_import_runs, so a staleness check (like importOewsCacheIfStale)
--     can decide whether the daily cron needs to do real work.
--
-- IMPORTANT: market_reference_breakpoints is populated exclusively by the
-- batch job in src/domain/market/reference-distribution-batch.ts computing
-- live values from Census/BLS/BEA. Nothing seeds this table with static
-- numbers — until the batch job has run at least once for a given
-- (metric, jurisdiction_level) pair, lookupPercentileRank() returns null.

CREATE TABLE IF NOT EXISTS market_reference_values (
  metric TEXT NOT NULL,
  jurisdiction_level TEXT NOT NULL,
  geo_id TEXT NOT NULL,
  geo_name TEXT NOT NULL,
  state_fips TEXT,
  value REAL NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (metric, jurisdiction_level, geo_id)
);

CREATE INDEX IF NOT EXISTS idx_market_reference_values_metric_level
  ON market_reference_values(metric, jurisdiction_level, value);

CREATE TABLE IF NOT EXISTS market_reference_breakpoints (
  metric TEXT NOT NULL,
  jurisdiction_level TEXT NOT NULL,
  p10 REAL NOT NULL,
  p20 REAL NOT NULL,
  p30 REAL NOT NULL,
  p40 REAL NOT NULL,
  p50 REAL NOT NULL,
  p60 REAL NOT NULL,
  p70 REAL NOT NULL,
  p80 REAL NOT NULL,
  p90 REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (metric, jurisdiction_level)
);

CREATE TABLE IF NOT EXISTS market_reference_batch_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  metrics_processed INTEGER NOT NULL DEFAULT 0,
  values_stored INTEGER NOT NULL DEFAULT 0,
  breakpoints_computed INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_reference_batch_runs_started_at
  ON market_reference_batch_runs(started_at DESC);
