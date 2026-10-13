-- One table for the links Desk e-mails: password_reset_tokens and email_confirmation_tokens had identical columns, so their
-- rows move into email_tokens with a `purpose` column ('password_reset' or 'email_confirmation'). Every lookup filters by
-- purpose, so a confirmation link can never be used as a reset link (or the other way round).
--
-- No data is lost: every row is copied with all its columns, then the copy is compared with the originals row by row and
-- value by value; any difference raises an error, and the migration runner rolls the whole file back (nothing changes).
--
-- Running code keeps working during the switch: the two old names become views onto email_tokens (one per purpose,
-- inserts get the right purpose automatically), so the version deployed before this one still reads and writes its links.
-- Migration 0034 drops the views (and plans.per_minute_limit) once the new version is deployed.
--
-- Rollback (before 0034):
--   DROP VIEW password_reset_tokens, email_confirmation_tokens;
--   CREATE TABLE password_reset_tokens AS SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'password_reset';
--   CREATE TABLE email_confirmation_tokens AS SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'email_confirmation';
--   then re-create the keys and indexes from 0002_auth.sql and DROP TABLE email_tokens.

-- Nothing may write a link while the rows are copied (a sign-up or reset in the meantime waits a moment).
LOCK TABLE password_reset_tokens, email_confirmation_tokens IN EXCLUSIVE MODE;

CREATE TABLE email_tokens (
  id         TEXT NOT NULL PRIMARY KEY,
  purpose    TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_confirmation')),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE UNIQUE INDEX idx_email_tokens_token ON email_tokens (token);
CREATE        INDEX idx_email_tokens_user ON email_tokens (purpose, user_id, created_at DESC);
CREATE        INDEX idx_email_tokens_expires_at ON email_tokens (expires_at);

INSERT INTO email_tokens (id, purpose, user_id, token, expires_at, used_at, created_at)
SELECT id, 'password_reset', user_id, token, expires_at, used_at, created_at FROM password_reset_tokens;
INSERT INTO email_tokens (id, purpose, user_id, token, expires_at, used_at, created_at)
SELECT id, 'email_confirmation', user_id, token, expires_at, used_at, created_at FROM email_confirmation_tokens;

-- Proof that nothing was lost or changed: no row (all columns compared) on one side only, and the totals add up.
DO $$
DECLARE missing bigint; extra bigint;
BEGIN
  SELECT count(*) INTO missing FROM (
    SELECT id, user_id, token, expires_at, used_at, created_at FROM password_reset_tokens
    EXCEPT ALL SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'password_reset') x;
  SELECT count(*) INTO extra FROM (
    SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'password_reset'
    EXCEPT ALL SELECT id, user_id, token, expires_at, used_at, created_at FROM password_reset_tokens) x;
  IF missing <> 0 OR extra <> 0 THEN RAISE EXCEPTION 'password reset links differ after copying (% missing, % extra)', missing, extra; END IF;

  SELECT count(*) INTO missing FROM (
    SELECT id, user_id, token, expires_at, used_at, created_at FROM email_confirmation_tokens
    EXCEPT ALL SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'email_confirmation') x;
  SELECT count(*) INTO extra FROM (
    SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'email_confirmation'
    EXCEPT ALL SELECT id, user_id, token, expires_at, used_at, created_at FROM email_confirmation_tokens) x;
  IF missing <> 0 OR extra <> 0 THEN RAISE EXCEPTION 'email confirmation links differ after copying (% missing, % extra)', missing, extra; END IF;

  IF (SELECT count(*) FROM email_tokens) <> (SELECT count(*) FROM password_reset_tokens) + (SELECT count(*) FROM email_confirmation_tokens) THEN
    RAISE EXCEPTION 'email_tokens row count does not match the two old tables';
  END IF;
END $$;

DROP TABLE password_reset_tokens;
DROP TABLE email_confirmation_tokens;

-- The old names, for the version still running until the next deploy (dropped by 0034).
CREATE VIEW password_reset_tokens AS
  SELECT id, user_id, token, expires_at, used_at, created_at, purpose FROM email_tokens WHERE purpose = 'password_reset'
  WITH CASCADED CHECK OPTION;
ALTER VIEW password_reset_tokens ALTER COLUMN purpose SET DEFAULT 'password_reset';
CREATE VIEW email_confirmation_tokens AS
  SELECT id, user_id, token, expires_at, used_at, created_at, purpose FROM email_tokens WHERE purpose = 'email_confirmation'
  WITH CASCADED CHECK OPTION;
ALTER VIEW email_confirmation_tokens ALTER COLUMN purpose SET DEFAULT 'email_confirmation';
