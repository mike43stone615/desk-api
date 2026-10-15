-- Teams are gone for good (replaced by sharing one key at a time, migration 0029): nothing reads or writes these any more.
--
-- Removes the three team tables, the team_id column on webhook_endpoints and gateway_api_keys, the two team triggers, and any
-- billing rows (subscriptions, usage, invoices) that belonged to a team rather than a person. A key or webhook that once
-- belonged to a team stays, with the person who made it as its owner (owner_user_id is untouched).
--
-- Rollback: re-run migrations 0021 and 0023 (the data in these tables is not kept).
DROP TRIGGER IF EXISTS trg_users_keep_team_keys ON users;
DROP FUNCTION IF EXISTS keep_team_keys_on_user_delete();

DELETE FROM invoices      WHERE subject_type = 'team';
DELETE FROM usage_meter   WHERE subject_type = 'team';
DELETE FROM subscriptions WHERE subject_type = 'team';

ALTER TABLE webhook_endpoints DROP COLUMN IF EXISTS team_id;
ALTER TABLE gateway_api_keys  DROP COLUMN IF EXISTS team_id;

DROP TABLE IF EXISTS team_email_invites;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams CASCADE; -- also drops its billing-cleanup trigger
