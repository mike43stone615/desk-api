-- Fixes a real race condition in the idempotency middleware (see
-- src/middleware/idempotency.ts): a key was only marked "seen" after the
-- handler finished, so two genuinely concurrent requests with the same key
-- both passed the "have I seen this?" check before either wrote its row,
-- and both executed — exactly the double-submit the feature exists to
-- prevent. The fix claims the key atomically at request start via an
-- INSERT ... ON CONFLICT DO NOTHING, storing the response separately once
-- the handler completes. response_status must be nullable to represent
-- "claimed, still in flight" before that completion write happens.

ALTER TABLE idempotency_keys ALTER COLUMN response_status DROP NOT NULL;
