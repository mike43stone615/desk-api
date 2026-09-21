-- Teams: several people share API keys and one allowance (the owner's decisions of 21 September 2026: limits are shared
-- across a team; roles owner / admin / developer / viewer; a team is its own table, not a business).
--
--   teams          one row per team; rate_limit_per_minute is an optional per-team limit set by an administrator
--   team_members   who belongs, with what role; a person becomes a member only after accepting (accepted_at)
--   gateway_api_keys.team_id   a key with a team belongs to the team, not to the person who made it
--
-- When a person is deleted their team keys are handed to the best remaining member (an owner, else an admin, else the
-- earliest joiner) and that member becomes an owner if none remains; a team with nobody left is deleted with its keys.
-- Teams are visited in id order so two people deleted at the same moment lock rows in the same order.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_users_keep_team_keys ON users;
--   DROP FUNCTION IF EXISTS keep_team_keys_on_user_delete();
--   ALTER TABLE gateway_api_keys DROP COLUMN IF EXISTS team_id;
--   DROP TABLE IF EXISTS team_members; DROP TABLE IF EXISTS teams;

CREATE TABLE IF NOT EXISTS teams (
  id                   TEXT NOT NULL PRIMARY KEY,
  name                 TEXT NOT NULL,
  created_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  rate_limit_per_minute INTEGER CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0),
  created_at           TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE TABLE IF NOT EXISTS team_members (
  id                 TEXT NOT NULL PRIMARY KEY,
  team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);

ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS team_id TEXT REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_team_id ON gateway_api_keys(team_id) WHERE team_id IS NOT NULL;

CREATE OR REPLACE FUNCTION keep_team_keys_on_user_delete() RETURNS trigger AS $$
DECLARE
  t RECORD;
  successor TEXT;
BEGIN
  FOR t IN SELECT DISTINCT tm.team_id FROM team_members tm WHERE tm.user_id = OLD.id ORDER BY tm.team_id LOOP
    PERFORM 1 FROM teams WHERE id = t.team_id FOR UPDATE;
    SELECT m.user_id INTO successor
      FROM team_members m
     WHERE m.team_id = t.team_id AND m.user_id <> OLD.id AND m.accepted_at IS NOT NULL
     ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, m.accepted_at ASC, m.id ASC
     LIMIT 1;
    IF successor IS NULL THEN
      DELETE FROM teams WHERE id = t.team_id;   -- its members and keys go with it
      CONTINUE;
    END IF;
    UPDATE gateway_api_keys SET owner_user_id = successor WHERE team_id = t.team_id AND owner_user_id = OLD.id;
    IF NOT EXISTS (
      SELECT 1 FROM team_members
       WHERE team_id = t.team_id AND user_id <> OLD.id AND accepted_at IS NOT NULL AND role = 'owner'
    ) THEN
      UPDATE team_members SET role = 'owner' WHERE team_id = t.team_id AND user_id = successor;
    END IF;
  END LOOP;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_keep_team_keys ON users;
CREATE TRIGGER trg_users_keep_team_keys
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION keep_team_keys_on_user_delete();
