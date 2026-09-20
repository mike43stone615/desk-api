-- Suspension: switching an account or one API key off WITHOUT deleting or revoking anything, so it can be switched back
-- on (a compromised key under investigation, an account being reviewed, a developer who asks to pause a key).
--  * a suspended account cannot sign in, its sessions were ended when it was suspended, and every key it owns is refused;
--  * a suspended key is refused (403 api_key_suspended) but keeps its backend keys and can be resumed.
-- Separate tables (not columns) so nothing that reads users or keys has to change, and the rows disappear with the
-- account / key (ON DELETE CASCADE).
--
-- Rollback:
--   DROP TABLE IF EXISTS key_suspensions;
--   DROP TABLE IF EXISTS account_suspensions;

CREATE TABLE IF NOT EXISTS account_suspensions (
  user_id      TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  suspended_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  reason       TEXT NOT NULL DEFAULT '',
  suspended_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS key_suspensions (
  api_key_id   TEXT NOT NULL PRIMARY KEY REFERENCES gateway_api_keys(id) ON DELETE CASCADE,
  suspended_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  reason       TEXT NOT NULL DEFAULT '',
  suspended_by TEXT NOT NULL DEFAULT ''
);
