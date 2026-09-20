-- Optimistic concurrency for setup drafts. Two browser tabs (or a tab and the phone app) editing the same draft used to
-- silently overwrite each other: the last save won. Each draft now carries a version that goes up by one on every save,
-- served as an ETag; a client may send If-Match with the version it read and is refused (412) if someone saved in between.
-- Clients that send no If-Match behave exactly as before.
--
-- Rollback:
--   ALTER TABLE business_setup_drafts DROP COLUMN IF EXISTS version;

ALTER TABLE business_setup_drafts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
