// E-mail subscriptions to the public status page (migration 0028): "tell me when something changes" instead of having to
// keep checking. Double opt-in — a subscription is not active (and nobody is emailed about it) until the confirmation link
// is clicked — so this cannot be used to sign someone else's address up for status e-mails they never asked for.
import { randomUUID, randomBytes } from 'crypto';
import { pool } from '../../db';
import { hashToken } from '../../infrastructure/auth/token-hash';

const CONFIRM_TTL_DAYS = 7;

export interface SubscribeOutcome {
  /** A confirmation e-mail should be sent with this token, or null when nothing needs to be sent (already confirmed, or a
   * confirmation went out inside the last day and repeating it would just be noise). */
  confirmToken: string | null;
}

/** Same answer either way: the caller cannot tell from this whether the address was already subscribed. */
export async function subscribe(email: string): Promise<SubscribeOutcome> {
  const address = email.trim().toLowerCase();
  const { rows } = await pool.query<{ confirmed_at: string | null; created_at: string }>(
    `SELECT confirmed_at, created_at FROM status_subscribers WHERE email = $1`,
    [address],
  );
  const existing = rows[0];
  if (existing?.confirmed_at) return { confirmToken: null };
  if (existing && Date.now() - Date.parse(existing.created_at) < 24 * 3_600_000) return { confirmToken: null };

  const confirmToken = randomBytes(32).toString('base64url');
  // Kept across a repeat signup for the same address instead of reissued, so an unsubscribe link already sent out never breaks.
  const unsubscribeToken = existing ? (await pool.query<{ unsubscribe_token: string }>(`SELECT unsubscribe_token FROM status_subscribers WHERE email = $1`, [address])).rows[0]!.unsubscribe_token : randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO status_subscribers (id, email, confirm_token_hash, confirm_expires_at, unsubscribe_token, created_at)
     VALUES ($1, $2, $3, $4, $5, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
     ON CONFLICT (email) DO UPDATE SET confirm_token_hash = $3, confirm_expires_at = $4, created_at = excluded.created_at`,
    [randomUUID(), address, hashToken(confirmToken), new Date(Date.now() + CONFIRM_TTL_DAYS * 86_400_000).toISOString(), unsubscribeToken],
  );
  // The confirm and unsubscribe tokens travel together in the confirmation e-mail: joined here so the route needs only one value.
  return { confirmToken: `${confirmToken}.${unsubscribeToken}` };
}

/** True on success. Single-use in effect: a second attempt with the same token finds nothing left to confirm. */
export async function confirm(token: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE status_subscribers SET confirmed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      WHERE confirm_token_hash = $1 AND confirm_expires_at > $2 AND confirmed_at IS NULL RETURNING id`,
    [hashToken(token), new Date().toISOString()],
  );
  return rows.length > 0;
}

/** Never expires (unlike the confirm token), so a link at the bottom of an old e-mail keeps working. True on success. */
export async function unsubscribe(token: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM status_subscribers WHERE unsubscribe_token = $1`, [token]);
  return (res.rowCount ?? 0) > 0;
}

/** Every confirmed subscriber, with the token their own unsubscribe link needs (not a secret: see the migration). */
export async function confirmedSubscribers(): Promise<Array<{ email: string; unsubscribeToken: string }>> {
  const { rows } = await pool.query<{ email: string; unsubscribe_token: string }>(`SELECT email, unsubscribe_token FROM status_subscribers WHERE confirmed_at IS NOT NULL`);
  return rows.map((r) => ({ email: r.email, unsubscribeToken: r.unsubscribe_token }));
}

export async function deleteExpiredUnconfirmed(): Promise<number> {
  const res = await pool.query(`DELETE FROM status_subscribers WHERE confirmed_at IS NULL AND confirm_expires_at < $1`, [new Date().toISOString()]);
  return res.rowCount ?? 0;
}
