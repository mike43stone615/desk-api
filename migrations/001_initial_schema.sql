-- Desk API - Initial D1 Schema
-- Compatible with both SQLite/D1 (current) and PostgreSQL (future migration target).
-- Timestamps stored as ISO-8601 UTC strings for portability.
-- IDs are lowercase hex UUIDs for portability.

-- Users
CREATE TABLE IF NOT EXISTS users (
  id           TEXT    PRIMARY KEY,
  email        TEXT    NOT NULL,
  password_hash TEXT   NOT NULL,
  email_confirmed_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Sessions - opaque token stored server-side (not JWT, no client-side secret)
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);
CREATE        INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions (user_id);
CREATE        INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- Password reset tokens - single-use, short-lived
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prt_token   ON password_reset_tokens (token);
CREATE        INDEX IF NOT EXISTS idx_prt_user_id ON password_reset_tokens (user_id);

-- Email confirmation tokens - single-use confirmation links for new signups
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
