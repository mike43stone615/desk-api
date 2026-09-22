-- Two-factor authentication (TOTP, RFC 6238) for developer accounts, plus one-time backup codes and a short-lived
-- "second factor pending" token issued after a password checks out but before a session is created.
--
-- The TOTP secret is encrypted (AES-256-GCM, the same scheme as gateway_api_key_grants.encrypted_backend_key), not hashed:
-- verifying a submitted code needs the secret back. Backup codes are hashed at rest (like every other token in this
-- service) since they are only ever compared, never read back.
--
-- Rollback:
--   DROP TABLE IF EXISTS mfa_pending_logins;
--   DROP TABLE IF EXISTS totp_backup_codes;
--   ALTER TABLE users DROP COLUMN IF EXISTS totp_secret_enc;
--   ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled_at;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TEXT;

CREATE TABLE IF NOT EXISTS totp_backup_codes (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_user_id ON totp_backup_codes(user_id);

-- Issued once a password is confirmed for an account with 2FA on; exchanged for a real session at POST
-- /auth/2fa/verify. Single-use (deleted the moment it is looked up, whether the code given is right or wrong, so a
-- wrong guess cannot be retried against the same token forever) and short-lived (10 minutes).
CREATE TABLE IF NOT EXISTS mfa_pending_logins (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_mfa_pending_logins_expires ON mfa_pending_logins(expires_at);
