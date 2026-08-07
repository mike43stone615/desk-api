-- Auth tables — Postgres port of the original D1 schema
-- (migrations/001_initial_schema.sql + 002_auth_email_confirmation_admin.sql
-- + 003_user_profile_names.sql from git history), consolidated into a
-- single migration since this is a fresh table set here rather than an
-- evolving one.
--
-- Column types/timestamps intentionally mirror the original's TEXT/ISO-8601
-- convention rather than native timestamptz/uuid — see the original D1
-- migration's own header comment ("Compatible with both SQLite/D1 (current)
-- and PostgreSQL (future migration target)"). Application code
-- (src/domain/auth/tokens.ts's nowUtc/addHours/addMinutes) generates and
-- compares these as ISO-8601 strings on both sides, so a later real data
-- migration from the live D1 database (a separate, later step — NOT done as
-- part of this rewrite) is a straight INSERT with no type coercion. `id` is
-- TEXT, generated in application code (generateId(), lowercase hex), not a
-- Postgres SERIAL or gen_random_uuid() default — same reasoning.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT NOT NULL PRIMARY KEY,
  email               TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  email_confirmed_at  TEXT,
  created_at          TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  updated_at          TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Sessions — opaque token stored server-side (not JWT, no client-side secret).
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);
CREATE        INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE        INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- Password reset tokens — single-use, short-lived.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prt_token      ON password_reset_tokens (token);
CREATE        INDEX IF NOT EXISTS idx_prt_user_id    ON password_reset_tokens (user_id);
CREATE        INDEX IF NOT EXISTS idx_prt_expires_at ON password_reset_tokens (expires_at);

-- Email confirmation tokens — single-use confirmation links for new signups.
CREATE TABLE IF NOT EXISTS email_confirmation_tokens (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ect_token      ON email_confirmation_tokens (token);
CREATE        INDEX IF NOT EXISTS idx_ect_user_id    ON email_confirmation_tokens (user_id);
CREATE        INDEX IF NOT EXISTS idx_ect_expires_at ON email_confirmation_tokens (expires_at);
