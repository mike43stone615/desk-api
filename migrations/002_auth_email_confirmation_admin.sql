-- Require new users to confirm their email before signing in.
-- Existing users are marked confirmed to avoid locking out current accounts.

ALTER TABLE users ADD COLUMN email_confirmed_at TEXT;

UPDATE users
SET email_confirmed_at = COALESCE(email_confirmed_at, created_at)
WHERE email_confirmed_at IS NULL;

CREATE TABLE IF NOT EXISTS email_confirmation_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ect_token ON email_confirmation_tokens (token);
CREATE        INDEX IF NOT EXISTS idx_ect_user_id ON email_confirmation_tokens (user_id);
CREATE        INDEX IF NOT EXISTS idx_ect_expires_at ON email_confirmation_tokens (expires_at);
