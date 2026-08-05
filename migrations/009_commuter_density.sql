-- Commuter-shed / workplace-density cache, sourced from the free Census
-- LEHD LODES dataset (Workplace Area Characteristics, "wac", S000/JT00 —
-- total jobs by workplace location, every ownership type). Gives a real
-- "how many jobs are actually performed here" figure per county, distinct
-- from resident population (ACS) — meaningfully different for a downtown
-- or commercial county where far more people work than live.
--
-- Populated exclusively by src/domain/market/commuter-density-batch.ts's
-- batch job (one U.S. state's LODES WAC file per shard, ticked by the same
-- frequent cron reference-distribution-batch.ts uses — see index.ts's
-- scheduled()). Nothing hardcodes county-level numbers here.

CREATE TABLE IF NOT EXISTS market_commuter_density (
  county_fips TEXT PRIMARY KEY,
  state_fips TEXT NOT NULL,
  geo_name TEXT NOT NULL,
  workplace_jobs INTEGER NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_market_commuter_density_state
  ON market_commuter_density(state_fips);

-- Tracks batch job executions, mirroring market_reference_batch_runs — but
-- this job's "shard plan" is always just "every U.S. state in a fixed
-- order" (see commuter-density-batch.ts's STATE_FIPS-derived order), so
-- progress is a plain integer cursor rather than a persisted JSON plan.
CREATE TABLE IF NOT EXISTS market_commuter_density_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  next_state_index INTEGER NOT NULL DEFAULT 0,
  total_states INTEGER NOT NULL DEFAULT 0,
  counties_stored INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_commuter_density_runs_started_at
  ON market_commuter_density_runs(started_at DESC);
