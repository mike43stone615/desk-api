-- A durable record of security-relevant events (sign-ins, failed sign-ins, password changes, sessions ended, API keys
-- created or revoked...). Until now these only went to the log, which is rotated and cannot be shown to the account's
-- owner. Each person can read their own (GET /auth/activity) to spot activity that is not theirs.
--
-- user_id is nullable and is set to NULL if the account is deleted (the event stays, without a person attached).
-- `subject` is a fingerprint of the email address (never the address) so failed sign-ins for an account can be shown
-- to that account's owner even though no session existed. Events older than 180 days are deleted daily.
--
-- Rollback:
--   DROP TABLE IF EXISTS security_events;

CREATE TABLE IF NOT EXISTS security_events (
  id          TEXT        NOT NULL PRIMARY KEY,
  user_id     TEXT        REFERENCES users(id) ON DELETE SET NULL,
  subject     TEXT,
  event       TEXT        NOT NULL,
  outcome     TEXT        NOT NULL CHECK (outcome IN ('ok', 'error')),
  ip_address  TEXT,
  user_agent  TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_user    ON security_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_subject ON security_events (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events (created_at);
