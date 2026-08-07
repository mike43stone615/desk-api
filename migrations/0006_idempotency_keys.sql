-- Idempotency-Key support for the two setup-draft creation endpoints
-- (POST /setup/drafts, POST /setup/drafts/:id/complete — see
-- middleware/idempotency.ts). Ported/adapted from compliance-os's Prisma
-- IdempotencyKey model to a plain table for this repo's raw-`pg` convention.
-- response_body is nullable (a 204/empty response has none); response_status
-- and response_body together are enough to replay the exact original
-- response on a duplicate submission.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT        NOT NULL PRIMARY KEY,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER     NOT NULL,
  response_body   JSONB,
  expires_at      TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
