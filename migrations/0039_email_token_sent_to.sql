-- email_tokens.sent_to: the address a confirmation or password-reset link was emailed to, kept on the link itself.
--
-- A person can change their email after a link is sent, so the address in Users is not always the one the link went to. The
-- Administration page shows this column. Links made before this migration have no value here (they are short-lived).
--
-- Additive and safe to run while the service is up: the running version simply does not fill it in until the new one is deployed.
-- Rollback: ALTER TABLE email_tokens DROP COLUMN IF EXISTS sent_to;
ALTER TABLE email_tokens ADD COLUMN IF NOT EXISTS sent_to TEXT;
