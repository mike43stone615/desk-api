-- SBA lending activity cache, sourced from SBA's free public FOIA loan-level
-- data (7(a) program, FY2020-Present CSV — data.sba.gov/en/dataset/7-a-504-foia).
-- An "access to capital" signal: how much SBA-backed lending activity is
-- actually happening in this state/industry, distinct from anything
-- Compliance-OS or Census tracks.
--
-- Populated exclusively by src/domain/market/sba-lending-batch.ts. See that
-- file's header for an important scope caveat: SBA's CSV resource URLs are
-- re-published quarterly with a new datestamp (discovered live via SBA's
-- CKAN API rather than hardcoded), and the file itself is large enough that
-- this job reads a size-capped prefix of it rather than the complete
-- dataset — see the batch file's comment for why, and what a fuller
-- implementation would need.

CREATE TABLE IF NOT EXISTS market_sba_lending (
  state_fips TEXT NOT NULL,
  naics_sector TEXT NOT NULL,
  loan_count INTEGER NOT NULL,
  total_gross_approval REAL NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (state_fips, naics_sector)
);

CREATE INDEX IF NOT EXISTS idx_market_sba_lending_state
  ON market_sba_lending(state_fips);

CREATE TABLE IF NOT EXISTS market_sba_lending_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  loans_stored INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_sba_lending_runs_started_at
  ON market_sba_lending_runs(started_at DESC);
