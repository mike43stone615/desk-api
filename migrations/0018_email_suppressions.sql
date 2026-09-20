-- Addresses we must stop emailing: the mail provider told us the address bounced permanently (it does not exist) or the
-- person marked a message as spam. Sending on to such an address hurts the domain's reputation for everyone, so
-- src/infrastructure/email/resend.ts skips them (and logs that it did). Filled by the provider's webhook
-- (POST /webhooks/resend, see src/routes/webhooks.ts).
--
-- Rollback: DROP TABLE IF EXISTS email_suppressions;

CREATE TABLE IF NOT EXISTS email_suppressions (
  email      TEXT NOT NULL PRIMARY KEY,   -- lower-case
  reason     TEXT NOT NULL,               -- 'bounced' | 'complained'
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
