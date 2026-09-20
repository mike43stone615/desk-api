-- What a person needs to recognise their own sessions in a "where am I signed in" list, and to spot one that is not
-- theirs: when it started (created_at, already there), when it was last used, the browser/app that signed in (user
-- agent) and the address it signed in from. Existing sessions simply show no details.
--
-- Rollback:
--   ALTER TABLE sessions DROP COLUMN IF EXISTS user_agent, DROP COLUMN IF EXISTS ip, DROP COLUMN IF EXISTS last_used_at;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_agent   TEXT,
  ADD COLUMN IF NOT EXISTS ip           TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TEXT;
