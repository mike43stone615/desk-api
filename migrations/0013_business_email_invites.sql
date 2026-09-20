-- Invitations to an email address that has no Desk account yet.
--
-- Until now, inviting an address with no account failed with "User not found", which let any business owner or admin
-- (anyone can create a business) find out whether an email address is registered. The invite route now answers the
-- same either way. For an address with no account the invitation is kept here, the address is emailed a link to sign
-- up, and when that address is confirmed the invitation becomes an ordinary pending membership (accepted only when
-- the person accepts it). Confirming the address is what proves it is theirs, so an invitation never attaches to an
-- account that merely typed the address. Unclaimed invitations expire after 30 days.
--
-- Rollback:
--   DROP TABLE IF EXISTS business_email_invites;

CREATE TABLE IF NOT EXISTS business_email_invites (
  id                 TEXT NOT NULL PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member', 'accountant')),
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  invited_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE (business_id, email)
);

CREATE INDEX IF NOT EXISTS idx_business_email_invites_email ON business_email_invites(email);
