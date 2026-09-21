// Invitations to an email address that has no Desk account yet (migration 0013). Kept until the address is confirmed
// by someone who signs up with it, then turned into a normal pending membership; expire after INVITE_TTL_DAYS.
import { pool } from '../../db';
import { generateId, nowUtc } from '../auth/tokens';

export const INVITE_TTL_DAYS = 30;
/** Bounds how many not-yet-registered people one business can have waiting. */
export const MAX_EMAIL_INVITES_PER_BUSINESS = 50;

/** Turns the business and team invitations waiting for this (just confirmed) address into pending memberships. Returns how many. */
export async function claimEmailInvites(user: { id: string; email: string }): Promise<number> {
  const email = user.email.trim().toLowerCase();
  const cutoff = new Date(Date.now() - INVITE_TTL_DAYS * 86_400_000).toISOString();
  const { rows } = await pool.query<{ business_id: string; role: string; invited_by_user_id: string | null; invited_at: string }>(
    `SELECT business_id, role, invited_by_user_id, invited_at FROM business_email_invites WHERE email = $1 AND invited_at > $2`,
    [email, cutoff],
  );
  const now = nowUtc();
  for (const invite of rows) {
    // Pending, exactly like an invitation to an existing account: the person still has to accept it.
    await pool.query(
      `INSERT INTO business_memberships (id, business_id, user_id, role, invited_by_user_id, invited_at, accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $7)
       ON CONFLICT (business_id, user_id) DO NOTHING`,
      [generateId(), invite.business_id, user.id, invite.role, invite.invited_by_user_id, invite.invited_at, now],
    );
  }
  await pool.query(`DELETE FROM business_email_invites WHERE email = $1`, [email]);

  // The same for teams: pending until the person accepts.
  const { rows: teamRows } = await pool.query<{ team_id: string; role: string; invited_by_user_id: string | null; invited_at: string }>(
    `SELECT team_id, role, invited_by_user_id, invited_at FROM team_email_invites WHERE email = $1 AND invited_at > $2`,
    [email, cutoff],
  );
  for (const invite of teamRows) {
    await pool.query(
      `INSERT INTO team_members (id, team_id, user_id, role, invited_by_user_id, created_at, accepted_at) VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [generateId(), invite.team_id, user.id, invite.role, invite.invited_by_user_id, invite.invited_at],
    );
  }
  await pool.query(`DELETE FROM team_email_invites WHERE email = $1`, [email]);
  return rows.length + teamRows.length;
}

export async function deleteExpiredEmailInvites(): Promise<void> {
  const cutoff = new Date(Date.now() - INVITE_TTL_DAYS * 86_400_000).toISOString();
  await pool.query(`DELETE FROM business_email_invites WHERE invited_at <= $1`, [cutoff]);
  await pool.query(`DELETE FROM team_email_invites WHERE invited_at <= $1`, [cutoff]);
}
