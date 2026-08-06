-- Add the access layer that lets more than one user reach the same business.
-- The existing businesses.user_id remains the creator/original owner for
-- backward compatibility; authorization should use business_memberships.

CREATE TABLE IF NOT EXISTS business_memberships (
  id          TEXT NOT NULL PRIMARY KEY,
  business_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'admin', 'member', 'accountant')),
  invited_by_user_id TEXT,
  invited_at  TEXT,
  accepted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_memberships_business_user
  ON business_memberships(business_id, user_id);

CREATE INDEX IF NOT EXISTS idx_business_memberships_user_id
  ON business_memberships(user_id);

CREATE INDEX IF NOT EXISTS idx_business_memberships_business_id
  ON business_memberships(business_id);

INSERT OR IGNORE INTO business_memberships (
  id,
  business_id,
  user_id,
  role,
  accepted_at,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  id,
  user_id,
  'owner',
  created_at,
  created_at,
  updated_at
FROM businesses;

CREATE INDEX IF NOT EXISTS idx_prt_expires_at
  ON password_reset_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_ect_expires_at
  ON email_confirmation_tokens(expires_at);
