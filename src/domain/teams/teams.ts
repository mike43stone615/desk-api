// Teams: several people sharing API keys and one allowance. The rules (owner's decisions, 21 September 2026):
//   * limits are shared: every key of a team draws on the team's allowance, not its own;
//   * roles: owner (everything, may delete the team), admin (keys and people, but cannot touch owners),
//     developer (creates keys and manages the ones they made), viewer (sees the team, its keys and their usage);
//   * a team is its own thing, not a business; a person joins only by accepting an invitation;
//   * a team key never carries the Desk API (it would act as whoever made it): only the Registry and Market APIs.
import { randomUUID } from 'crypto';
import { pool } from '../../db';

export const TEAM_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const MAX_TEAMS_CREATED_PER_USER = 5;
export const MAX_KEYS_PER_TEAM = 25;
export const MAX_MEMBERS_PER_TEAM = 50;

export type TeamErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'limit_reached'
  | 'already_member'
  | 'last_owner'
  | 'invalid_role';

export class TeamError extends Error {
  constructor(
    public readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

const NOW_SQL = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const RANK: Record<TeamRole, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export interface TeamSummary {
  id: string;
  name: string;
  role: TeamRole;
  memberCount: number;
  keyCount: number;
  createdAt: string;
  /** A limit an administrator set for the whole team (calls a minute), or null for the standard team limit. */
  rateLimitPerMinute: number | null;
}

/** Same shape as a business member (see setup.ts): the membership's own id, who they are under `user`, and the dates. */
export interface TeamMemberRow {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  invitedByUserId: string | null;
  invitedAt: string | null;
  /** null while the invitation has not been accepted. */
  acceptedAt: string | null;
  createdAt: string;
  user: { email: string; firstName: string; lastName: string };
}

/** The person's ACCEPTED role in a team, or null when they are not a member (an unaccepted invitation gives nothing). */
export async function roleIn(teamId: string, userId: string): Promise<TeamRole | null> {
  const { rows } = await pool.query<{ role: TeamRole }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
    [teamId, userId],
  );
  return rows[0]?.role ?? null;
}

export function atLeast(role: TeamRole | null, needed: TeamRole): boolean {
  return role !== null && RANK[role] >= RANK[needed];
}

async function requireRole(teamId: string, userId: string, needed: TeamRole): Promise<TeamRole> {
  const role = await roleIn(teamId, userId);
  // A stranger and a team that does not exist look the same: nothing confirms a team is there.
  if (!role) throw new TeamError('not_found', 'Team not found.');
  if (!atLeast(role, needed)) throw new TeamError('forbidden', `That needs the ${needed} role or higher in this team.`);
  return role;
}

export const teams = {
  async create(userId: string, name: string): Promise<TeamSummary> {
    const { rows: c } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM teams WHERE created_by_user_id = $1`, [userId]);
    if (Number(c[0]?.n ?? 0) >= MAX_TEAMS_CREATED_PER_USER) {
      throw new TeamError('limit_reached', `You can create at most ${MAX_TEAMS_CREATED_PER_USER} teams.`);
    }
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO teams (id, name, created_by_user_id) VALUES ($1, $2, $3)`, [id, name, userId]);
      await client.query(
        `INSERT INTO team_members (id, team_id, user_id, role, accepted_at) VALUES ($1, $2, $3, 'owner', ${NOW_SQL})`,
        [randomUUID(), id, userId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return (await this.list(userId)).find((t) => t.id === id)!;
  },

  /** The teams the person belongs to (accepted), with their own role in each. */
  async list(userId: string): Promise<TeamSummary[]> {
    const { rows } = await pool.query<{ id: string; name: string; role: TeamRole; created_at: string; rate_limit_per_minute: number | null; members: string; keys: string }>(
      `SELECT t.id, t.name, m.role, t.created_at, t.rate_limit_per_minute,
              (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id AND x.accepted_at IS NOT NULL) AS members,
              (SELECT COUNT(*) FROM gateway_api_keys k WHERE k.team_id = t.id AND k.revoked_at IS NULL) AS keys
         FROM teams t JOIN team_members m ON m.team_id = t.id
        WHERE m.user_id = $1 AND m.accepted_at IS NOT NULL
        ORDER BY t.created_at ASC, t.id ASC`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, memberCount: Number(r.members), keyCount: Number(r.keys), createdAt: r.created_at, rateLimitPerMinute: r.rate_limit_per_minute ?? null }));
  },

  /** One team and its members. Any accepted member may look. Pending invitations are shown to admins and owners only. */
  async get(teamId: string, userId: string): Promise<{ team: TeamSummary; members: TeamMemberRow[] }> {
    const role = await requireRole(teamId, userId, 'viewer');
    const team = (await this.list(userId)).find((t) => t.id === teamId);
    if (!team) throw new TeamError('not_found', 'Team not found.');
    const { rows } = await pool.query<{ id: string; team_id: string; user_id: string; email: string; first_name: string; last_name: string; role: TeamRole; invited_by_user_id: string | null; accepted_at: string | null; created_at: string }>(
      `SELECT m.id, m.team_id, m.user_id, u.email, u.first_name, u.last_name, m.role, m.invited_by_user_id, m.accepted_at, m.created_at
         FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1
        ORDER BY (m.role = 'owner') DESC, u.email ASC, m.id ASC`,
      [teamId],
    );
    const seePending = atLeast(role, 'admin');
    return {
      team,
      members: rows.filter((r) => r.accepted_at || seePending).map((r) => ({
        id: r.id,
        teamId: r.team_id,
        userId: r.user_id,
        role: r.role,
        invitedByUserId: r.invited_by_user_id,
        invitedAt: r.invited_by_user_id ? r.created_at : null,
        acceptedAt: r.accepted_at,
        createdAt: r.created_at,
        user: { email: r.email, firstName: r.first_name, lastName: r.last_name },
      })),
    };
  },

  /**
   * Invites an existing account by e-mail. The answer is the same whether or not the address has an account (nothing
   * says who is registered); only an account that exists gets a pending membership. An admin may invite developers and
   * viewers; only an owner may invite admins or owners.
   */
  async invite(teamId: string, inviterId: string, email: string, role: TeamRole): Promise<void> {
    const mine = await requireRole(teamId, inviterId, 'admin');
    if ((role === 'owner' || role === 'admin') && mine !== 'owner') throw new TeamError('forbidden', 'Only an owner can invite an admin or another owner.');
    const { rows: c } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = $1`, [teamId]);
    if (Number(c[0]?.n ?? 0) >= MAX_MEMBERS_PER_TEAM) throw new TeamError('limit_reached', `A team can have at most ${MAX_MEMBERS_PER_TEAM} members.`);
    const { rows: u } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email.trim()]);
    const target = u[0]?.id;
    if (!target) return; // same answer as for a real account
    await pool.query(
      `INSERT INTO team_members (id, team_id, user_id, role, invited_by_user_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [randomUUID(), teamId, target, role, inviterId],
    );
  },

  /** Invitations waiting for the person. */
  async pendingFor(userId: string): Promise<Array<{ id: string; teamId: string; teamName: string; role: TeamRole; invitedAt: string; invitedByUserId: string | null; invitedBy: { email: string; firstName: string; lastName: string } | null }>> {
    const { rows } = await pool.query<{ id: string; team_id: string; name: string; role: TeamRole; created_at: string; invited_by_user_id: string | null; email: string | null; first_name: string | null; last_name: string | null }>(
      `SELECT m.id, m.team_id, t.name, m.role, m.created_at, m.invited_by_user_id, i.email, i.first_name, i.last_name
         FROM team_members m JOIN teams t ON t.id = m.team_id LEFT JOIN users i ON i.id = m.invited_by_user_id
        WHERE m.user_id = $1 AND m.accepted_at IS NULL ORDER BY m.created_at ASC, m.id ASC`,
      [userId],
    );
    // Same names as a pending business invitation (see setup.ts): id, teamName, invitedAt, invitedByUserId, invitedBy.
    return rows.map((r) => ({
      id: r.id,
      teamId: r.team_id,
      teamName: r.name,
      role: r.role,
      invitedAt: r.created_at,
      invitedByUserId: r.invited_by_user_id,
      invitedBy: r.email ? { email: r.email, firstName: r.first_name ?? '', lastName: r.last_name ?? '' } : null,
    }));
  },

  /** Accepts an invitation; returns the team's id. */
  async accept(membershipId: string, userId: string): Promise<string> {
    const res = await pool.query<{ team_id: string }>(
      `UPDATE team_members SET accepted_at = ${NOW_SQL} WHERE id = $1 AND user_id = $2 AND accepted_at IS NULL RETURNING team_id`,
      [membershipId, userId],
    );
    if (!res.rowCount) throw new TeamError('not_found', 'Invitation not found.');
    return res.rows[0].team_id;
  },

  /** Declines an invitation (or withdraws one, for an admin: see removeMember). */
  async decline(membershipId: string, userId: string): Promise<void> {
    const res = await pool.query(`DELETE FROM team_members WHERE id = $1 AND user_id = $2 AND accepted_at IS NULL`, [membershipId, userId]);
    if (!res.rowCount) throw new TeamError('not_found', 'Invitation not found.');
  },

  async changeRole(teamId: string, actorId: string, membershipId: string, role: TeamRole): Promise<void> {
    const mine = await requireRole(teamId, actorId, 'admin');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM teams WHERE id = $1 FOR UPDATE`, [teamId]);
      const { rows } = await client.query<{ user_id: string; role: TeamRole; accepted_at: string | null }>(
        `SELECT user_id, role, accepted_at FROM team_members WHERE id = $1 AND team_id = $2`,
        [membershipId, teamId],
      );
      const target = rows[0];
      if (!target) throw new TeamError('not_found', 'Member not found.');
      // Only an owner may change an owner or an admin, or hand out those roles.
      if (mine !== 'owner' && (RANK[target.role] >= RANK.admin || RANK[role] >= RANK.admin)) {
        throw new TeamError('forbidden', 'Only an owner can change an owner or admin, or make someone one.');
      }
      if (target.role === 'owner' && role !== 'owner') {
        const { rows: o } = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM team_members WHERE team_id = $1 AND role = 'owner' AND accepted_at IS NOT NULL AND id <> $2`,
          [teamId, membershipId],
        );
        if (Number(o[0]?.n ?? 0) === 0) throw new TeamError('last_owner', 'A team must keep at least one owner. Make someone else an owner first.');
      }
      await client.query(`UPDATE team_members SET role = $1 WHERE id = $2`, [role, membershipId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Removes a member (or withdraws an invitation). A person may always remove themselves (leave); an admin may remove
   * developers, viewers and invitations; an owner may remove anyone but the last owner.
   */
  async removeMember(teamId: string, actorId: string, membershipId: string): Promise<void> {
    const mine = await roleIn(teamId, actorId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM teams WHERE id = $1 FOR UPDATE`, [teamId]);
      const { rows } = await client.query<{ user_id: string; role: TeamRole; accepted_at: string | null }>(
        `SELECT user_id, role, accepted_at FROM team_members WHERE id = $1 AND team_id = $2`,
        [membershipId, teamId],
      );
      const target = rows[0];
      const self = target?.user_id === actorId;
      if (!target || (!self && !mine)) throw new TeamError('not_found', 'Member not found.');
      if (!self) {
        if (!atLeast(mine, 'admin')) throw new TeamError('forbidden', 'Only an admin or owner can remove other people.');
        if (mine !== 'owner' && RANK[target.role] >= RANK.admin && target.accepted_at) throw new TeamError('forbidden', 'Only an owner can remove an admin or owner.');
      }
      if (target.role === 'owner' && target.accepted_at) {
        const { rows: o } = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM team_members WHERE team_id = $1 AND role = 'owner' AND accepted_at IS NOT NULL AND id <> $2`,
          [teamId, membershipId],
        );
        if (Number(o[0]?.n ?? 0) === 0) throw new TeamError('last_owner', 'The last owner cannot leave. Make someone else an owner, or delete the team.');
      }
      // Keys the person made stay with the team (they belong to it), handed to the best remaining member.
      if (target.accepted_at) {
        const { rows: s } = await client.query<{ user_id: string }>(
          `SELECT user_id FROM team_members
            WHERE team_id = $1 AND id <> $2 AND accepted_at IS NOT NULL
            ORDER BY (role = 'owner') DESC, (role = 'admin') DESC, accepted_at ASC, id ASC LIMIT 1`,
          [teamId, membershipId],
        );
        if (s[0]) await client.query(`UPDATE gateway_api_keys SET owner_user_id = $1 WHERE team_id = $2 AND owner_user_id = $3`, [s[0].user_id, teamId, target.user_id]);
      }
      await client.query(`DELETE FROM team_members WHERE id = $1`, [membershipId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  /** Owner only. The caller (gateway route) revokes the team's keys first; the rows go with the team. */
  async assertCanDelete(teamId: string, userId: string): Promise<void> {
    await requireRole(teamId, userId, 'owner');
  },

  async remove(teamId: string): Promise<void> {
    await pool.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
  },

  /** Who may see and who may manage a key. Used by the key routes. */
  async requireMember(teamId: string, userId: string, needed: TeamRole): Promise<TeamRole> {
    return requireRole(teamId, userId, needed);
  },

  /** An administrator gives a whole team its own per-minute limit (null clears it). */
  async setLimit(teamId: string, perMinute: number | null): Promise<boolean> {
    const res = await pool.query(`UPDATE teams SET rate_limit_per_minute = $2 WHERE id = $1`, [teamId, perMinute]);
    return (res.rowCount ?? 0) > 0;
  },
};

/**
 * Whether the person may manage (revoke, change the APIs of, switch off) a key, and if so the key's recorded owner (the
 * value the key routines match on). A personal key: only its owner. A team key: an admin or owner of the team, or the
 * developer who made it.
 */
export async function keyManagerOwner(userId: string, keyId: string): Promise<string | null> {
  const { rows } = await pool.query<{ owner_user_id: string; team_id: string | null }>(`SELECT owner_user_id, team_id FROM gateway_api_keys WHERE id = $1`, [keyId]);
  const key = rows[0];
  if (!key) return null;
  if (!key.team_id) return key.owner_user_id === userId ? key.owner_user_id : null;
  const role = await roleIn(key.team_id, userId);
  if (atLeast(role, 'admin')) return key.owner_user_id;
  if (role === 'developer' && key.owner_user_id === userId) return key.owner_user_id;
  return null;
}

/** Whether the person may look at a key's usage: its owner for a personal key, any member of the team for a team key. */
export async function keyViewerOwner(userId: string, keyId: string): Promise<string | null> {
  const { rows } = await pool.query<{ owner_user_id: string; team_id: string | null }>(`SELECT owner_user_id, team_id FROM gateway_api_keys WHERE id = $1`, [keyId]);
  const key = rows[0];
  if (!key) return null;
  if (!key.team_id) return key.owner_user_id === userId ? key.owner_user_id : null;
  return (await roleIn(key.team_id, userId)) ? key.owner_user_id : null;
}
