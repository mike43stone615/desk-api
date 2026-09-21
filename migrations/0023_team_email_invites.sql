-- Team invitations to an email address that has no Desk account yet (the team counterpart of business_email_invites, 0013).
--
-- The invite route answers the same whether or not the address has an account. For an address with no account the invitation
-- is kept here and the address is emailed a link to sign up; when that address is confirmed by someone who signs up with it,
-- the invitation becomes an ordinary pending team membership (still accepted only when the person accepts it). Unclaimed
-- invitations expire after 30 days (the same job that clears the business ones).
--
-- Rollback:
--   DROP TABLE IF EXISTS team_email_invites;

CREATE TABLE IF NOT EXISTS team_email_invites (
  id                 TEXT NOT NULL PRIMARY KEY,
  team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  invited_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE (team_id, email)
);

CREATE INDEX IF NOT EXISTS idx_team_email_invites_email ON team_email_invites(email);
