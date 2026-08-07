-- Admin mutation audit log — ported from market-validation-api's
-- migrations/0009_mutation_audit_log.sql (itself ported from compliance-os's
-- Prisma model). Append-only: rows are never updated or deleted by
-- application code. `id` has no DB-side default because
-- modules/audit/mutation-audit.ts's logMutation() always supplies a fresh
-- crypto.randomUUID() explicitly, matching this repo's "id generated in
-- application code" convention used everywhere else (users, sessions,
-- business_setup_drafts, ...).

CREATE TABLE IF NOT EXISTS mutation_audit_log (
  id          TEXT        NOT NULL PRIMARY KEY,
  user_id     TEXT,
  user_email  TEXT,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   TEXT        NOT NULL,
  before      JSONB,
  after       JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mutation_audit_log_entity     ON mutation_audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_mutation_audit_log_user_id    ON mutation_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_mutation_audit_log_created_at ON mutation_audit_log (created_at);
