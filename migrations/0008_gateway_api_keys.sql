-- API Library keys: one gateway key per developer-created credential, with a
-- per-service grant row for each API the key is enabled for (desk_api,
-- registry_api, market_validation_api). Same key shape as registry-api's and
-- market-validation-api's own api_keys tables (SHA-256 hash at rest, prefix
-- kept for display, soft revocation) — the plaintext is shown exactly once,
-- at creation.
--
-- registry_api / market_validation_api grants additionally carry a REAL
-- backend-native key, provisioned through that service's admin key endpoint
-- at grant time. That one has to be readable again by this service to
-- forward requests, so it is stored ENCRYPTED (AES-256-GCM, see
-- src/domain/gateway/crypto.ts), not hashed. desk_api grants need neither
-- column: the key simply resolves to its owner's own users.id.
--
-- Rollback (no data outside these two tables depends on them):
--   DROP TABLE IF EXISTS gateway_api_key_grants;
--   DROP TABLE IF EXISTS gateway_api_keys;

CREATE TABLE IF NOT EXISTS gateway_api_keys (
  id            TEXT NOT NULL PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_owner_user_id ON gateway_api_keys(owner_user_id);

CREATE TABLE IF NOT EXISTS gateway_api_key_grants (
  id                    TEXT NOT NULL PRIMARY KEY,
  api_key_id            TEXT NOT NULL REFERENCES gateway_api_keys(id) ON DELETE CASCADE,
  service               TEXT NOT NULL
    CHECK (service IN ('desk_api', 'registry_api', 'market_validation_api')),
  backend_key_id        TEXT,
  encrypted_backend_key TEXT,
  created_at            TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE (api_key_id, service)
);

CREATE INDEX IF NOT EXISTS idx_gateway_api_key_grants_api_key_id ON gateway_api_key_grants(api_key_id);
