-- Session, password-reset and email-confirmation tokens are stored as "sha256:<hex>" instead of the token itself,
-- so a leaked database does not hand out working sessions or reset links (API Library keys already worked this way).
-- The application hashes on write and on lookup; this converts the rows written before hashing existed.
-- Safe to run more than once: rows already converted start with "sha256:" and are skipped.
--
-- Rollback: there is none by design -- the original tokens cannot be recovered from their hashes. If the hashing code
-- is ever reverted, users simply sign in again and request new links.
UPDATE sessions
   SET token = 'sha256:' || encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token NOT LIKE 'sha256:%';

UPDATE password_reset_tokens
   SET token = 'sha256:' || encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token NOT LIKE 'sha256:%';

UPDATE email_confirmation_tokens
   SET token = 'sha256:' || encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token NOT LIKE 'sha256:%';
