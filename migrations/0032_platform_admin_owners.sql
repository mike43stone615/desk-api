-- Owners can promote an administrator to owner from the "Who has access" pop-up on the Administration page.
--
-- An owner is either an address in the server setting ADMIN_EMAILS (as before) or a person on platform_admins with role 'owner'.
-- Owners add, remove and promote administrators; nobody can remove or demote an owner from the page (an owner set in
-- ADMIN_EMAILS is changed in the server settings; a promoted owner only by editing this table directly).
--
-- Rollback:
--   ALTER TABLE platform_admins DROP COLUMN IF EXISTS promoted_at, DROP COLUMN IF EXISTS promoted_by_email, DROP COLUMN IF EXISTS role;

ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS promoted_by_email TEXT;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS promoted_at TEXT;
DO $$ BEGIN
  ALTER TABLE platform_admins ADD CONSTRAINT platform_admins_role_check CHECK (role IN ('admin', 'owner'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
