-- API key expiry and usage counters.
--  * gateway_api_keys.expires_at: an optional date after which the key stops working (chosen when the key is created).
--    NULL = never expires (every key made before this migration). Independently of that, a key that has not been used
--    for 180 days is refused as idle (see src/domain/gateway/keys.ts), and a nightly job revokes expired/idle keys.
--  * gateway_key_usage: one row per key per day with the number of calls and how many of them ended in an error, so a
--    developer can see their own usage (GET /gateway/api-keys/:id/usage). Rows go with the key.
--
-- Rollback:
--   DROP TABLE IF EXISTS gateway_key_usage;
--   ALTER TABLE gateway_api_keys DROP COLUMN IF EXISTS expires_at;

ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS expires_at TEXT;

CREATE TABLE IF NOT EXISTS gateway_key_usage (
  api_key_id TEXT NOT NULL REFERENCES gateway_api_keys(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  calls      INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, day)
);
