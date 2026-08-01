CREATE TABLE IF NOT EXISTS oews_wage_rows (
  dataset_year INTEGER NOT NULL,
  area_code TEXT NOT NULL,
  area_name TEXT NOT NULL,
  state_code TEXT NOT NULL,
  occupation_code TEXT NOT NULL,
  occupation_title TEXT NOT NULL,
  employment INTEGER,
  hourly_mean_wage REAL,
  annual_mean_wage INTEGER,
  hourly_median_wage REAL,
  annual_median_wage INTEGER,
  source_url TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (dataset_year, area_code, occupation_code)
);

CREATE INDEX IF NOT EXISTS idx_oews_wage_rows_state_occ_year
  ON oews_wage_rows(state_code, occupation_code, dataset_year DESC);

CREATE TABLE IF NOT EXISTS oews_import_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  dataset_year INTEGER,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oews_import_runs_started_at
  ON oews_import_runs(started_at DESC);
