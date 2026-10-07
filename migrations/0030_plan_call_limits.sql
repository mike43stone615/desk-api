-- Plans get call limits for each API (per minute and per month), a limit across all three, an app-registration limit and
-- a price for calls beyond the monthly limits. Prices and limits follow the API Library plans page (October 2026):
--   Free      $0   each API 60/min 300/month, all APIs 100/min 500/month, 10 keys, 3 webhooks, 1 app, 5 analyses
--   Pro      $15   each API 600/min 3,000/month, all 1,000/min 5,000/month, 25 keys, 10 webhooks, 3 apps, 75 analyses
--   Business $50   each API 3,000/min 15,000/month, all 3,000/min 15,000/month, 100 keys, 50 webhooks, 10 apps, 350 analyses
-- Calls beyond a monthly limit: refused on Free; on Pro $0.05 and on Business $0.03 each. Analyses beyond the included
-- number: refused on Free; $0.30 each on paid plans. Per-minute limits always refuse. The 'developer' plan keeps its id
-- (subscriptions and invoices point at it) and is now called Pro.
--
-- Why these numbers make money: the only API calls a key can make that cost Desk money per call are market analyses
-- (one Google Places text search of up to 3 pages, ~$0.035 a page, plus one Foursquare search: ~$0.12 at worst, less when
-- cached). Every other call a key can make reads Desk's own data or free government data. Worst case per month:
-- Pro 75 x $0.12 = $9 < $15; Business 350 x $0.12 = $42 < $50; an extra analysis $0.30 > $0.12; Free 5 x $0.12 = $0.60.
--
-- api_usage counts calls made with API Library keys, per person, API and window ('m' + YYYY-MM-DDTHH:MM for a minute,
-- 'M' + YYYY-MM for a month). Minute rows older than a day are deleted by the daily job.
--
-- Rollback: DROP TABLE api_usage; ALTER TABLE plans DROP COLUMN service_per_minute, DROP COLUMN service_per_month,
--   DROP COLUMN total_per_minute, DROP COLUMN total_per_month, DROP COLUMN max_apps, DROP COLUMN overage_cents_per_call;
--   and restore the 0022 prices (developer 'Developer' 2900/3000/5/120/25/10, business 9900/15000/3/300/100/50,
--   free 300 analyses).

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS service_per_minute     INTEGER NOT NULL DEFAULT 60    CHECK (service_per_minute > 0),
  ADD COLUMN IF NOT EXISTS service_per_month      INTEGER NOT NULL DEFAULT 300   CHECK (service_per_month > 0),
  ADD COLUMN IF NOT EXISTS total_per_minute       INTEGER NOT NULL DEFAULT 100   CHECK (total_per_minute > 0),
  ADD COLUMN IF NOT EXISTS total_per_month        INTEGER NOT NULL DEFAULT 500   CHECK (total_per_month > 0),
  ADD COLUMN IF NOT EXISTS max_apps               INTEGER NOT NULL DEFAULT 1     CHECK (max_apps >= 0),
  -- what one call beyond a monthly limit costs; NULL = such calls are refused
  ADD COLUMN IF NOT EXISTS overage_cents_per_call INTEGER CHECK (overage_cents_per_call IS NULL OR overage_cents_per_call >= 0);

UPDATE plans SET name = 'Free', monthly_price_cents = 0, included_analyses = 5, overage_cents_per_analysis = NULL,
  per_minute_limit = 100, max_keys = 10, max_webhooks = 3, service_per_minute = 60, service_per_month = 300,
  total_per_minute = 100, total_per_month = 500, max_apps = 1, overage_cents_per_call = NULL, sort_order = 1 WHERE id = 'free';
UPDATE plans SET name = 'Pro', monthly_price_cents = 1500, included_analyses = 75, overage_cents_per_analysis = 30,
  per_minute_limit = 1000, max_keys = 25, max_webhooks = 10, service_per_minute = 600, service_per_month = 3000,
  total_per_minute = 1000, total_per_month = 5000, max_apps = 3, overage_cents_per_call = 5, sort_order = 2 WHERE id = 'developer';
UPDATE plans SET name = 'Business', monthly_price_cents = 5000, included_analyses = 350, overage_cents_per_analysis = 30,
  per_minute_limit = 3000, max_keys = 100, max_webhooks = 50, service_per_minute = 3000, service_per_month = 15000,
  total_per_minute = 3000, total_per_month = 15000, max_apps = 10, overage_cents_per_call = 3, sort_order = 3 WHERE id = 'business';

CREATE TABLE IF NOT EXISTS api_usage (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service  TEXT NOT NULL CHECK (service IN ('desk_api', 'registry_api', 'market_validation_api')),
  window_key TEXT NOT NULL,            -- 'm2026-10-07T14:05' (a minute, UTC) or 'M2026-10' (a month, UTC)
  calls    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_key, service)
);
