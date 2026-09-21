-- Round 3 (September 2026).
--
-- 1. A key can be limited to some parts of the Desk API ("desk_scopes": profile, drafts, businesses) and can carry its own
--    per-minute limit ("rate_limit_per_minute", set by an administrator for a partner). Existing keys keep every scope and
--    the standard limit.
-- 2. A mail queue: an e-mail the provider refused (or could not be reached for) is kept briefly and tried again, instead of
--    being lost. A row is removed as soon as it is sent, and dropped after a few failed tries (the links inside expire
--    anyway); nothing here is kept long.
-- 3. system_state: small named facts the service remembers between restarts (the mail key's fingerprint, so a changed key
--    is tested once).
--
-- Rollback:
--   ALTER TABLE gateway_api_keys DROP COLUMN desk_scopes, DROP COLUMN rate_limit_per_minute;
--   DROP TABLE email_outbox; DROP TABLE system_state;

ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS desk_scopes text[] NOT NULL DEFAULT ARRAY['profile', 'drafts', 'businesses'] CHECK (desk_scopes <@ ARRAY['profile', 'drafts', 'businesses']);
ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute BETWEEN 1 AND 6000);

CREATE TABLE IF NOT EXISTS email_outbox (
  id              text PRIMARY KEY,
  to_email        text NOT NULL,
  subject         text NOT NULL,
  html            text NOT NULL,
  text_body       text,
  kind            text NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON email_outbox (next_attempt_at);

CREATE TABLE IF NOT EXISTS system_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
