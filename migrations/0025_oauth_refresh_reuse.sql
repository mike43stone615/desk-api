-- OAuth refresh-token reuse detection.
--
-- A refresh token already works only once (each refresh replaces it). This remembers the token that was just replaced, so that when
-- somebody presents it again (a copy was stolen, or an app misbehaved) the whole grant can be ended instead of just being refused.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_oauth_tokens_previous_refresh; ALTER TABLE oauth_tokens DROP COLUMN IF EXISTS previous_refresh_hash;

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS previous_refresh_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_previous_refresh ON oauth_tokens(previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;
