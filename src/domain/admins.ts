// Who may use the administrator pages. Two groups:
//   - owners: the addresses in the server setting ADMIN_EMAILS. Always allowed, and the only people who can change the list.
//   - listed administrators: accounts on the platform_admins list (migration 0024), added and removed by an owner.
// A listed administrator must still have a confirmed e-mail address when they use the pages, so the list can only ever hold
// (and admit) accounts whose address a real person has confirmed.
import { pool } from '../db';
import { config } from '../config';

export class AdminAccessError extends Error {
  constructor(public readonly code: 'no_such_account' | 'unconfirmed' | 'already_admin' | 'is_owner' | 'not_listed', message: string) {
    super(message);
  }
}

export interface ListedAdmin { userId: string; email: string; firstName: string; lastName: string; addedAt: string; addedBy: string | null; note: string | null }

export const isOwnerEmail = (email: string): boolean => config.adminEmails.includes(email.trim().toLowerCase());

/** True when the account is on the list AND its e-mail address is confirmed. */
export async function isListedAdmin(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM platform_admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND u.email_confirmed_at IS NOT NULL`,
    [userId],
  );
  return rows.length > 0;
}

export async function accessFor(user: { id: string; email: string }): Promise<{ isOwner: boolean; isAdmin: boolean }> {
  const isOwner = isOwnerEmail(user.email);
  return { isOwner, isAdmin: isOwner || (await isListedAdmin(user.id)) };
}

export async function listAdmins(): Promise<{ owners: string[]; admins: ListedAdmin[] }> {
  const { rows } = await pool.query<{ user_id: string; email: string; first_name: string; last_name: string; added_at: string; added_by_email: string | null; note: string | null }>(
    `SELECT a.user_id, u.email, u.first_name, u.last_name, a.added_at, a.added_by_email, a.note
       FROM platform_admins a JOIN users u ON u.id = a.user_id ORDER BY a.added_at ASC`,
  );
  return {
    owners: [...config.adminEmails],
    admins: rows.map((r) => ({ userId: r.user_id, email: r.email, firstName: r.first_name, lastName: r.last_name, addedAt: r.added_at, addedBy: r.added_by_email, note: r.note })),
  };
}

/** Adds an existing, confirmed account by e-mail address. */
export async function addAdmin(email: string, by: { id: string; email: string }, note?: string): Promise<ListedAdmin> {
  const address = email.trim().toLowerCase();
  if (config.adminEmails.includes(address)) throw new AdminAccessError('is_owner', 'That address is already an owner and always has access.');
  const { rows: u } = await pool.query<{ id: string; email: string; first_name: string; last_name: string; email_confirmed_at: string | null }>(
    `SELECT id, email, first_name, last_name, email_confirmed_at FROM users WHERE lower(email) = $1`,
    [address],
  );
  const user = u[0];
  if (!user) throw new AdminAccessError('no_such_account', 'There is no Desk account with that address. They need to sign up and confirm their e-mail first.');
  if (!user.email_confirmed_at) throw new AdminAccessError('unconfirmed', 'That account has not confirmed its e-mail address yet.');
  const { rows } = await pool.query<{ added_at: string }>(
    `INSERT INTO platform_admins (user_id, added_by_user_id, added_by_email, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO NOTHING RETURNING added_at`,
    [user.id, by.id, by.email, note?.trim() || null],
  );
  if (!rows[0]) throw new AdminAccessError('already_admin', 'That person is already on the list.');
  return { userId: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, addedAt: rows[0].added_at, addedBy: by.email, note: note?.trim() || null };
}

export async function removeAdmin(userId: string): Promise<string> {
  const { rows } = await pool.query<{ email: string }>(
    `DELETE FROM platform_admins a USING users u WHERE a.user_id = $1 AND u.id = a.user_id RETURNING u.email`,
    [userId],
  );
  if (!rows[0]) throw new AdminAccessError('not_listed', 'That person is not on the list.');
  return rows[0].email;
}
