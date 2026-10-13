-- Plan changes on a schedule, and invoices that charge each plan for the part of the month it was active.
--
--   canceled_at        when a subscription stopped (it was only marked 'canceled', with no time, so a month in which
--                      someone changed plan could not be billed: a downgrade before the month ended left that month unbilled,
--                      and a late upgrade was billed as a whole month)
--   scheduled_plan_id  a change waiting for its date (a downgrade takes effect at the start of next month: the person keeps
--   scheduled_for      what they have until then); applied by the job on the 1st, or on the next lookup after that date
--
-- Subscriptions canceled before this migration have no canceled_at; they are treated as having ended when they began
-- (nothing is billed for them), which only matters for months before this version.
--
-- Rollback: ALTER TABLE subscriptions DROP COLUMN canceled_at, DROP COLUMN scheduled_plan_id, DROP COLUMN scheduled_for;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS canceled_at TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS scheduled_plan_id TEXT REFERENCES plans(id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS scheduled_for TEXT;
CREATE INDEX IF NOT EXISTS subscriptions_scheduled_idx ON subscriptions (scheduled_for) WHERE scheduled_for IS NOT NULL AND status <> 'canceled';
