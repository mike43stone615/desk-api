-- Payment methods on file, so a paid plan can require one (changePlan in src/domain/billing/plans.ts).
--
-- Nothing writes here yet: rows are added by the payment provider's integration once one is connected. provider_ref is the
-- provider's own id for the method (never a card number); brand and last4 are only for showing it. Deleting a person
-- removes their methods.
--
-- Rollback: DROP TABLE payment_methods;
CREATE TABLE IF NOT EXISTS payment_methods (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  brand        TEXT,
  last4        TEXT,
  created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
