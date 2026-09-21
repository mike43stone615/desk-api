-- Who may use the administrator pages, beyond the owner(s) named in the server setting ADMIN_EMAILS.
--
-- The owner(s) in ADMIN_EMAILS always have access and are the only ones who can add or remove people here (so an administrator
-- cannot add more administrators, and nobody can lock the owner out by editing this table). A person on this list must have a
-- Desk account with a confirmed e-mail address; the list stores the account (not the e-mail address), so an address nobody has
-- confirmed can never gain access by signing up later. Deleting the account removes the person from the list.
--
-- Rollback:
--   DROP TABLE IF EXISTS platform_admins;

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id          TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_by_email   TEXT,
  note             TEXT,
  added_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
