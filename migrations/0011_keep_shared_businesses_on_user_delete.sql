-- businesses.user_id is the CREATOR of a business, and it cascades: deleting the creator used to delete the whole
-- business, including for every other person who had been given access. A business that other people still belong to
-- must survive its creator leaving.
--
-- Before a user is deleted (by any path: admin browser, direct SQL, a future "delete account"), each business they
-- created that has at least one OTHER accepted member is handed to the best remaining member (an owner, else an
-- admin, else whoever joined first). If nobody who is left holds the owner role, that member becomes an owner, so a
-- business is never left without one. A business with no other accepted member is deleted as before.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_users_keep_shared_businesses ON users;
--   DROP FUNCTION IF EXISTS keep_shared_businesses_on_user_delete();

CREATE OR REPLACE FUNCTION keep_shared_businesses_on_user_delete() RETURNS trigger AS $$
DECLARE
  biz RECORD;
  successor TEXT;
BEGIN
  FOR biz IN SELECT id FROM businesses WHERE user_id = OLD.id LOOP
    SELECT m.user_id INTO successor
      FROM business_memberships m
     WHERE m.business_id = biz.id AND m.user_id <> OLD.id AND m.accepted_at IS NOT NULL
     ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, m.accepted_at ASC, m.id ASC
     LIMIT 1;
    IF successor IS NULL THEN
      CONTINUE; -- nobody else: the business goes with its creator, as before
    END IF;
    UPDATE businesses SET user_id = successor WHERE id = biz.id;
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

DROP TRIGGER IF EXISTS trg_users_keep_shared_businesses ON users;
CREATE TRIGGER trg_users_keep_shared_businesses
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION keep_shared_businesses_on_user_delete();
