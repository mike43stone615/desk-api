-- E-mail subscriptions to the public status page: "tell me when something changes" instead of having to keep
-- checking. Double opt-in (a subscription is not active until the confirmation link is clicked), so this cannot be
-- used to sign someone else's address up. The unsubscribe token is separate from the confirm token, never expires (so a
-- link in an old e-mail keeps working), and is stored in plain text (not hashed, unlike every other token here): it grants
-- nothing beyond removing that one address from this list, the same one-click, no-login unsubscribe every mailing list
-- uses, and keeping it readable lets every future notice reuse it without a second secret to manage.
--
-- Rollback:
--   DROP TABLE IF EXISTS status_subscribers;

CREATE TABLE IF NOT EXISTS status_subscribers (
  id                    TEXT NOT NULL PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  confirm_token_hash    TEXT NOT NULL,
  confirm_expires_at    TEXT NOT NULL,
  unsubscribe_token       TEXT NOT NULL UNIQUE,
  confirmed_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_status_subscribers_confirmed ON status_subscribers(confirmed_at) WHERE confirmed_at IS NOT NULL;
