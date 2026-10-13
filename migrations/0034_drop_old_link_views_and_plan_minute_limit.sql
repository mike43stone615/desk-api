-- Finishes 0033 once the version that uses email_tokens directly is deployed: the two compatibility views go, and so does
-- plans.per_minute_limit, which held the same numbers as plans.total_per_minute (the key limiter now reads that column,
-- and the API's perMinuteLimit field reports it).
--
-- Refuses (nothing changes) if any plan's per_minute_limit differs from its total_per_minute, so dropping it can never
-- change anyone's limit; fix the plan first (or keep the column) in that case.
--
-- Rollback: CREATE VIEW password_reset_tokens / email_confirmation_tokens as in 0033;
--   ALTER TABLE plans ADD COLUMN per_minute_limit INTEGER CHECK (per_minute_limit IS NULL OR per_minute_limit > 0);
--   UPDATE plans SET per_minute_limit = total_per_minute;

DO $$
DECLARE differing text;
BEGIN
  SELECT string_agg(id || ' (' || coalesce(per_minute_limit::text, 'empty') || ' vs ' || total_per_minute || ')', ', ') INTO differing
    FROM plans WHERE per_minute_limit IS DISTINCT FROM total_per_minute;
  IF differing IS NOT NULL THEN RAISE EXCEPTION 'plans whose per_minute_limit differs from total_per_minute: %', differing; END IF;
END $$;

DROP VIEW IF EXISTS password_reset_tokens;
DROP VIEW IF EXISTS email_confirmation_tokens;
ALTER TABLE plans DROP COLUMN IF EXISTS per_minute_limit;
