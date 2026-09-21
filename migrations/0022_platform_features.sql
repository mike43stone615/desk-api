-- Platform features added 21 September 2026 (all additive; nothing existing changes shape):
--   sandbox keys        gateway_api_keys.sandbox: a key that answers with fixed sample data and calls no backend
--   plans and billing   plans, subscriptions, usage_meter, invoices (metering and draft invoices; no payment provider yet)
--   outbound webhooks   webhook_endpoints, webhook_deliveries (signed, retried, replay-protected)
--   OAuth 2.0           oauth_clients, oauth_codes, oauth_tokens (authorization code + PKCE, rotating refresh tokens)
--   status page         incidents, incident_updates
--
-- Rollback: DROP TABLE incident_updates, incidents, oauth_tokens, oauth_codes, oauth_clients, webhook_deliveries,
--   webhook_endpoints, invoices, usage_meter, subscriptions, plans; ALTER TABLE gateway_api_keys DROP COLUMN sandbox;
--   DROP TRIGGER trg_users_billing_cleanup ON users; DROP TRIGGER trg_teams_billing_cleanup ON teams;
--   DROP FUNCTION cleanup_billing_subject();

ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS sandbox BOOLEAN NOT NULL DEFAULT FALSE;

-- ── plans and billing ────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  description               TEXT NOT NULL DEFAULT '',
  monthly_price_cents       INTEGER NOT NULL DEFAULT 0 CHECK (monthly_price_cents >= 0),
  included_analyses         INTEGER NOT NULL DEFAULT 0 CHECK (included_analyses >= 0),
  -- what one market analysis beyond the included number costs; NULL = never billed (the daily cap still applies)
  overage_cents_per_analysis INTEGER CHECK (overage_cents_per_analysis IS NULL OR overage_cents_per_analysis >= 0),
  -- calls a minute for each key; NULL = the standard limit
  per_minute_limit          INTEGER CHECK (per_minute_limit IS NULL OR per_minute_limit > 0),
  max_keys                  INTEGER NOT NULL DEFAULT 10 CHECK (max_keys > 0),
  max_webhooks              INTEGER NOT NULL DEFAULT 3 CHECK (max_webhooks >= 0),
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order                INTEGER NOT NULL DEFAULT 0
);

-- DRAFT PRICES: illustrative numbers so the mechanics can be tested. Change them here (UPDATE plans ...) before charging anyone.
INSERT INTO plans (id, name, description, monthly_price_cents, included_analyses, overage_cents_per_analysis, per_minute_limit, max_keys, max_webhooks, sort_order) VALUES
  ('free',      'Free',      'Everything needed to try the APIs. The standard limits apply.',                                   0,    300,   NULL, NULL, 10,  3, 1),
  ('developer', 'Developer', 'For one developer shipping a product: more calls, more keys, usage beyond the included billed.',  2900, 3000,  5,    120,  25, 10, 2),
  ('business',  'Business',  'For a team in production: the highest limits and the most included analyses.',                   9900, 15000, 3,    300, 100, 50, 3)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriptions (
  id             TEXT PRIMARY KEY,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('user', 'team')),
  subject_id     TEXT NOT NULL,
  plan_id        TEXT NOT NULL REFERENCES plans(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  -- who collects the money: 'manual' until a payment provider is connected
  provider       TEXT NOT NULL DEFAULT 'manual',
  provider_ref   TEXT,
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_active_subject ON subscriptions(subject_type, subject_id) WHERE status <> 'canceled';

CREATE TABLE IF NOT EXISTS usage_meter (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'team')),
  subject_id   TEXT NOT NULL,
  month        TEXT NOT NULL,            -- YYYY-MM (UTC)
  metric       TEXT NOT NULL,            -- 'market_analyses'
  quantity     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_type, subject_id, month, metric)
);

CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('user', 'team')),
  subject_id     TEXT NOT NULL,
  plan_id        TEXT NOT NULL REFERENCES plans(id),
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'usd',
  lines          TEXT NOT NULL DEFAULT '[]',   -- JSON: [{description, quantity, unitCents, totalCents}]
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void')),
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE (subject_type, subject_id, period_start)
);

-- A person or a team going away takes its billing rows with it (the subject id is not a foreign key: it is either kind).
CREATE OR REPLACE FUNCTION cleanup_billing_subject() RETURNS trigger AS $$
BEGIN
  DELETE FROM subscriptions WHERE subject_type = TG_ARGV[0] AND subject_id = OLD.id;
  DELETE FROM usage_meter   WHERE subject_type = TG_ARGV[0] AND subject_id = OLD.id;
  DELETE FROM invoices      WHERE subject_type = TG_ARGV[0] AND subject_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_users_billing_cleanup ON users;
CREATE TRIGGER trg_users_billing_cleanup AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION cleanup_billing_subject('user');
DROP TRIGGER IF EXISTS trg_teams_billing_cleanup ON teams;
CREATE TRIGGER trg_teams_billing_cleanup AFTER DELETE ON teams FOR EACH ROW EXECUTE FUNCTION cleanup_billing_subject('team');

-- ── outbound webhooks ────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                   TEXT PRIMARY KEY,
  owner_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id              TEXT REFERENCES teams(id) ON DELETE CASCADE,
  url                  TEXT NOT NULL,
  secret_enc           TEXT NOT NULL,
  events               TEXT[] NOT NULL,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_reason      TEXT,
  created_at           TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_owner ON webhook_endpoints(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_team ON webhook_endpoints(team_id) WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  delivered_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);

-- ── OAuth 2.0 for third-party apps ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,                 -- the client_id
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  redirect_uris TEXT[] NOT NULL,
  secret_hash   TEXT,                             -- NULL = a public client (a mobile or single-page app): PKCE only
  scopes        TEXT[] NOT NULL,
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_owner ON oauth_clients(owner_user_id);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  scopes         TEXT[] NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                 TEXT PRIMARY KEY,
  access_hash        TEXT NOT NULL UNIQUE,
  refresh_hash       TEXT NOT NULL UNIQUE,
  client_id          TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes             TEXT[] NOT NULL,
  access_expires_at  TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  last_used_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);

-- ── status page incidents ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incidents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  status      TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  started_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents(started_at DESC);

CREATE TABLE IF NOT EXISTS incident_updates (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, created_at);
