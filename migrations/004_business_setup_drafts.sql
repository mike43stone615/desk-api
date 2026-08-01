CREATE TABLE IF NOT EXISTS business_setup_drafts (
  user_id TEXT PRIMARY KEY NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_business_setup_drafts_updated_at
  ON business_setup_drafts(updated_at);