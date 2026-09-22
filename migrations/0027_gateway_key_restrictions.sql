-- Two optional restrictions an owner can put on their own API key, tighter than the existing service/scope choice:
--   - allowed_ips: the key is refused from any other address (empty/NULL = usable from anywhere, today's behavior).
--   - restricted_business_id: with the "businesses" Desk scope, limits what the key can see to one business, for
--     someone who belongs to more than one and wants a key that can only ever touch a single one.
--
-- Rollback:
--   ALTER TABLE gateway_api_keys DROP COLUMN IF EXISTS allowed_ips;
--   ALTER TABLE gateway_api_keys DROP COLUMN IF EXISTS restricted_business_id;

ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS allowed_ips TEXT[];
ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS restricted_business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE;
