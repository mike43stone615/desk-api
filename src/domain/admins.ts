// Who may use the administrator pages. Two groups:
//   - owners: the addresses in the server setting ADMIN_EMAILS, plus anyone an owner promoted (platform_admins.role = 'owner',
//     migration 0032). Always allowed, and the only people who can change the list. Nobody can remove or promote an owner here.
//   - listed administrators: accounts on the platform_admins list (migration 0024) with role 'admin', added, removed and
//     promoted by an owner.
// A listed person must still have a confirmed e-mail address when they use the pages, so the list can only ever hold
// (and admit) accounts whose address a real person has confirmed.
import { pool } from '../db';
import { config } from '../config';

export class AdminAccessError extends Error {
  constructor(public readonly code: 'no_such_account' | 'unconfirmed' | 'already_admin' | 'is_owner' | 'not_listed', message: string) {
    super(message);
  }
}

export interface ListedAdmin { userId: string; email: string; firstName: string; lastName: string; addedAt: string; addedBy: string | null; note: string | null }
/** An owner as the "Who has access" pop-up shows them. userId is null for an ADMIN_EMAILS address nobody has signed up with. */
export interface Owner { userId: string | null; email: string; firstName: string; lastName: string; fromSettings: boolean }

export const isOwnerEmail = (email: string): boolean => config.adminEmails.includes(email.trim().toLowerCase());

/** True when the account is on the list (as administrator or promoted owner) AND its e-mail address is confirmed. */
export async function isListedAdmin(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM platform_admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND u.email_confirmed_at IS NOT NULL`,
    [userId],
  );
  return rows.length > 0;
}

/** The role on the list ('admin' or 'owner') of a confirmed account, or null when the account is not on it. */
async function listedRole(userId: string): Promise<'admin' | 'owner' | null> {
  const { rows } = await pool.query<{ role: 'admin' | 'owner' }>(
    `SELECT a.role FROM platform_admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND u.email_confirmed_at IS NOT NULL`,
    [userId],
  );
  return rows[0]?.role ?? null;
}

export async function accessFor(user: { id: string; email: string }): Promise<{ isOwner: boolean; isAdmin: boolean }> {
  if (isOwnerEmail(user.email)) return { isOwner: true, isAdmin: true };
  const role = await listedRole(user.id);
  return { isOwner: role === 'owner', isAdmin: role !== null };
}

export async function listAdmins(): Promise<{ owners: Owner[]; admins: ListedAdmin[] }> {
  const { rows } = await pool.query<{ user_id: string; email: string; first_name: string; last_name: string; role: string; added_at: string; added_by_email: string | null; note: string | null }>(
    `SELECT a.user_id, u.email, u.first_name, u.last_name, a.role, a.added_at, a.added_by_email, a.note
       FROM platform_admins a JOIN users u ON u.id = a.user_id ORDER BY a.added_at ASC`,
  );
  // Owners from the server setting: show the account's name when the address has one.
  const { rows: settingsUsers } = config.adminEmails.length
    ? await pool.query<{ id: string; email: string; first_name: string; last_name: string }>(
      `SELECT id, lower(email) AS email, first_name, last_name FROM users WHERE lower(email) = ANY($1)`, [config.adminEmails])
    : { rows: [] };
  const byEmail = new Map(settingsUsers.map((u) => [u.email, u]));
  const owners: Owner[] = config.adminEmails.map((email) => {
    const u = byEmail.get(email);
    return { userId: u?.id ?? null, email, firstName: u?.first_name ?? '', lastName: u?.last_name ?? '', fromSettings: true };
  });
  for (const r of rows) {
    if (r.role === 'owner' && !isOwnerEmail(r.email)) owners.push({ userId: r.user_id, email: r.email, firstName: r.first_name, lastName: r.last_name, fromSettings: false });
  }
  return {
    owners,
    admins: rows.filter((r) => r.role !== 'owner' && !isOwnerEmail(r.email))
      .map((r) => ({ userId: r.user_id, email: r.email, firstName: r.first_name, lastName: r.last_name, addedAt: r.added_at, addedBy: r.added_by_email, note: r.note })),
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

/** Why an action on userId was refused: an owner (from the settings or promoted) is never removed or promoted here. */
async function refusal(userId: string): Promise<AdminAccessError> {
  const { rows } = await pool.query<{ email: string; role: string | null }>(
    `SELECT u.email, a.role FROM users u LEFT JOIN platform_admins a ON a.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (r && (r.role === 'owner' || isOwnerEmail(r.email))) return new AdminAccessError('is_owner', 'That person is an owner. Owners cannot be removed or promoted here.');
  return new AdminAccessError('not_listed', 'That person is not on the list.');
}

export async function removeAdmin(userId: string): Promise<string> {
  const { rows } = await pool.query<{ email: string }>(
    `DELETE FROM platform_admins a USING users u WHERE a.user_id = $1 AND u.id = a.user_id AND a.role = 'admin' RETURNING u.email`,
    [userId],
  );
  if (!rows[0]) throw await refusal(userId);
  return rows[0].email;
}

/** Makes a listed administrator an owner (they can then add, remove and promote administrators too). */
export async function promoteAdmin(userId: string, by: { email: string }): Promise<string> {
  const { rows } = await pool.query<{ email: string }>(
    `UPDATE platform_admins a SET role = 'owner', promoted_by_email = $2, promoted_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
       FROM users u WHERE a.user_id = $1 AND u.id = a.user_id AND a.role = 'admin' AND u.email_confirmed_at IS NOT NULL RETURNING u.email`,
    [userId, by.email],
  );
  if (!rows[0]) throw await refusal(userId);
  return rows[0].email;
}
