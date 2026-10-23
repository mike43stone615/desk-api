-- safe_jsonb(text): the text as jsonb, or NULL when it is not valid JSON (instead of an error).
--
-- The Administration page shows what is inside a business's stored setup data (businesses.business_json) as ordinary columns, so
-- it can be filtered and sorted. One business with damaged JSON must show empty columns, not break the whole table, so every
-- read goes through this function. IMMUTABLE: the same text always gives the same answer.
--
-- Additive; nothing else uses it. Rollback: DROP FUNCTION safe_jsonb(text);
CREATE OR REPLACE FUNCTION safe_jsonb(t text) RETURNS jsonb AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
