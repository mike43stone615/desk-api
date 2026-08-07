-- Business-setup drafts (multi-row per user, capped at the application
-- layer — see routes/setup.ts's MAX_INCOMPLETE_DRAFTS) and completed
-- businesses. Postgres port of the original D1 schema's final state after
-- 004_business_setup_drafts.sql + 006_business_drafts_multi_and_businesses.sql
-- (git history) — this is a fresh table here, so both are folded into one
-- migration at the multi-row shape directly, skipping the intermediate
-- user_id-singleton shape the original started from.

CREATE TABLE IF NOT EXISTS business_setup_drafts (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_business_setup_drafts_user_id    ON business_setup_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_business_setup_drafts_updated_at ON business_setup_drafts(updated_at);

CREATE TABLE IF NOT EXISTS businesses (
  id            TEXT NOT NULL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  industry      TEXT,
  business_json TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  updated_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);
