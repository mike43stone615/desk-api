-- Business memberships — the access layer letting more than one user reach
-- the same business. Postgres port of the original D1
-- 011_business_memberships_and_token_cleanup_indexes.sql (git history).
-- businesses.user_id remains the creator/original owner for backward
-- compatibility; authorization uses business_memberships.

CREATE TABLE IF NOT EXISTS business_memberships (
  id                 TEXT NOT NULL PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'admin', 'member', 'accountant')),
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  invited_at         TEXT,
  accepted_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  updated_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_memberships_business_user
  ON business_memberships(business_id, user_id);

CREATE INDEX IF NOT EXISTS idx_business_memberships_user_id     ON business_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_business_memberships_business_id ON business_memberships(business_id);

-- Every business created before memberships existed gets a backfilled
-- owner-membership row for its creator (mirrors the original migration's
-- INSERT ... SELECT). On a fresh database (this rewrite's actual target —
-- see this migration's header) `businesses` is empty at migration time, so
-- this is a no-op here; kept for parity with the original and in case rows
-- are ever inserted directly ahead of this migration running.
INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at, created_at, updated_at)
SELECT
  -- md5() instead of gen_random_bytes()/gen_random_uuid() so this migration
  -- has no dependency on the pgcrypto extension being installed.
  md5(random()::text || clock_timestamp()::text || id),
  id,
  user_id,
  'owner',
  created_at,
  created_at,
  updated_at
FROM businesses
ON CONFLICT (business_id, user_id) DO NOTHING;
