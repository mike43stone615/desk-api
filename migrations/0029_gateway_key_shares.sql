-- Sharing one API key with another person by email — replaces the Teams feature (see migrations 0021, 0023, both
-- left in place but no longer written to) with a much smaller model: one owner, a handful of individually-invited
-- viewers, no roles or hierarchy. A share starts pending; its recipient accepts or declines it from "Key shared
-- with me" on the API Library page. An accepted share lets its holder see the key's usage and settings — never its
-- secret, and never switch it off, rotate it, revoke it, or add/remove an API on it; only the owner can do that.
--
-- Rollback:
--   DROP TABLE IF EXISTS gateway_key_shares;

CREATE TABLE IF NOT EXISTS gateway_key_shares (
  id                   TEXT NOT NULL PRIMARY KEY,
  api_key_id           TEXT NOT NULL REFERENCES gateway_api_keys(id) ON DELETE CASCADE,
  shared_with_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE (api_key_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_gateway_key_shares_user ON gateway_key_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_gateway_key_shares_key ON gateway_key_shares(api_key_id);
