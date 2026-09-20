-- Found by the lock stress test (scripts/stress-locks.mjs): migration 0011 only looked after businesses that the deleted
-- person CREATED. Two owners could remove one another / delete their account in an unlucky order and leave a business
-- with nobody in it (or with members but no owner) that still held its data and that nobody could reach.
--
-- Now, before a user is deleted, EVERY business they belong to (as creator or as an accepted member) is looked at:
--   * someone else accepted remains  -> the best remaining member takes over (an owner, else an admin, else the earliest
--     joiner); if no owner remains that member becomes an owner; if the deleted person was the recorded creator, the
--     successor becomes the recorded creator
--   * nobody else remains            -> the business is deleted with its data
-- Businesses are visited in id order, so two people deleted at the same time take the row locks in the same order.
--
-- Rollback: re-run the function body from the 0011 migration (the trigger itself is unchanged).

CREATE OR REPLACE FUNCTION keep_shared_businesses_on_user_delete() RETURNS trigger AS $$
DECLARE
  biz RECORD;
  successor TEXT;
BEGIN
  FOR biz IN
    SELECT b.id, b.user_id AS creator
      FROM businesses b
     WHERE b.user_id = OLD.id
        OR EXISTS (SELECT 1 FROM business_memberships m WHERE m.business_id = b.id AND m.user_id = OLD.id)
     ORDER BY b.id
       FOR UPDATE OF b
  LOOP
    SELECT m.user_id INTO successor
      FROM business_memberships m
     WHERE m.business_id = biz.id AND m.user_id <> OLD.id AND m.accepted_at IS NOT NULL
     ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, m.accepted_at ASC, m.id ASC
     LIMIT 1;
    IF successor IS NULL THEN
      -- nobody else: the business goes with the person (the creator's own delete cascades; otherwise remove it here)
      IF biz.creator <> OLD.id THEN
        DELETE FROM businesses WHERE id = biz.id;
      END IF;
      CONTINUE;
    END IF;
    IF biz.creator = OLD.id THEN
      UPDATE businesses SET user_id = successor WHERE id = biz.id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM business_memberships
       WHERE business_id = biz.id AND user_id <> OLD.id AND accepted_at IS NOT NULL AND role = 'owner'
    ) THEN
      UPDATE business_memberships SET role = 'owner'
       WHERE business_id = biz.id AND user_id = successor;
    END IF;
  END LOOP;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
