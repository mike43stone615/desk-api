-- A developer's backend keys (registry-api / market-validation-api) live in those services, so deleting the rows
-- here does not stop them working. Until now deleting a user (which cascades to their gateway keys and grants) left
-- their backend keys live and unreachable to revoke, because the only record of their ids went with the rows.
--
-- This queue closes that for EVERY way a grant can disappear (admin browser, direct SQL, a future "delete account"):
-- a trigger copies the backend key id of any grant being deleted into the queue in the same transaction, and a
-- background sweeper revokes each one upstream and removes it. A failed attempt stays queued and is retried.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_gateway_grant_queue_backend_revocation ON gateway_api_key_grants;
--   DROP FUNCTION IF EXISTS gateway_grant_queue_backend_revocation();
--   DROP TABLE IF EXISTS gateway_backend_key_revocations;

CREATE TABLE IF NOT EXISTS gateway_backend_key_revocations (
  id             TEXT NOT NULL PRIMARY KEY,
  service        TEXT NOT NULL CHECK (service IN ('registry_api', 'market_validation_api')),
  backend_key_id TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE OR REPLACE FUNCTION gateway_grant_queue_backend_revocation() RETURNS trigger AS $$
BEGIN
  IF OLD.backend_key_id IS NOT NULL AND OLD.service IN ('registry_api', 'market_validation_api') THEN
    INSERT INTO gateway_backend_key_revocations (id, service, backend_key_id)
    VALUES (md5(random()::text || clock_timestamp()::text || OLD.id), OLD.service, OLD.backend_key_id);
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gateway_grant_queue_backend_revocation ON gateway_api_key_grants;
CREATE TRIGGER trg_gateway_grant_queue_backend_revocation
  BEFORE DELETE ON gateway_api_key_grants
  FOR EACH ROW EXECUTE FUNCTION gateway_grant_queue_backend_revocation();
