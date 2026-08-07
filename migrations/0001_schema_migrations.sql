-- Migration tracking table. Ported from registry-api's/market-validation-api's
-- identical 004_/0006_schema_migrations.sql. filename is the migration
-- file's basename (e.g. '0002_auth.sql'), so it sorts/matches directly
-- against what's on disk in migrations/.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
