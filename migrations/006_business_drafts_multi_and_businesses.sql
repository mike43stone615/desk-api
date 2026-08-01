-- Convert business_setup_drafts from a user_id-singleton to a multi-row table
-- (id-keyed, many drafts per user, capped at the application layer) and add
-- a businesses table for completed setups.

ALTER TABLE business_setup_drafts RENAME TO business_setup_drafts_old;

CREATE TABLE business_setup_drafts (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_business_setup_drafts_user_id
  ON business_setup_drafts(user_id);

CREATE INDEX IF NOT EXISTS idx_business_setup_drafts_updated_at
  ON business_setup_drafts(updated_at);

INSERT INTO business_setup_drafts (id, user_id, draft_json, created_at, updated_at)
SELECT lower(hex(randomblob(16))), user_id, draft_json, created_at, updated_at
FROM business_setup_drafts_old;

DROP TABLE business_setup_drafts_old;

-- Completed businesses
CREATE TABLE IF NOT EXISTS businesses (
  id            TEXT NOT NULL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  industry      TEXT,
  business_json TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);
