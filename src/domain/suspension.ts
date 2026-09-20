// Suspending an account or one API key without deleting anything (migration 0016).
import { pool } from '../db';

const clip = (s: string) => s.trim().slice(0, 300);

export async function isUserSuspended(userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM account_suspensions WHERE user_id = $1`, [userId]);
  return rows.length > 0;
}

/** Suspends the account and ends every session it has, so it is locked out at once. False when there is no such user. */
export async function suspendUser(userId: string, reason: string, by: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  if (rows.length === 0) return false;
  await pool.query(
    `INSERT INTO account_suspensions (user_id, reason, suspended_by) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, suspended_by = EXCLUDED.suspended_by`,
    [userId, clip(reason), clip(by)],
  );
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return true;
}

export async function unsuspendUser(userId: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM account_suspensions WHERE user_id = $1`, [userId]);
  return (res.rowCount ?? 0) > 0;
}

/** Suspends a key (owner: pass their id; admin: pass null to allow any key). False when the key does not exist / is not theirs / is revoked. */
export async function suspendKey(keyId: string, ownerUserId: string | null, reason: string, by: string): Promise<boolean> {
  const { rows } = await pool.query(
    ownerUserId === null
      ? `SELECT id FROM gateway_api_keys WHERE id = $1 AND revoked_at IS NULL`
      : `SELECT id FROM gateway_api_keys WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
    ownerUserId === null ? [keyId] : [keyId, ownerUserId],
  );
  if (rows.length === 0) return false;
  await pool.query(
    `INSERT INTO key_suspensions (api_key_id, reason, suspended_by) VALUES ($1, $2, $3)
     ON CONFLICT (api_key_id) DO UPDATE SET reason = EXCLUDED.reason, suspended_by = EXCLUDED.suspended_by`,
    [keyId, clip(reason), clip(by)],
  );
  return true;
}

export async function resumeKey(keyId: string, ownerUserId: string | null): Promise<boolean> {
  const res = await pool.query(
    ownerUserId === null
      ? `DELETE FROM key_suspensions WHERE api_key_id = $1`
      : `DELETE FROM key_suspensions WHERE api_key_id = $1 AND api_key_id IN (SELECT id FROM gateway_api_keys WHERE owner_user_id = $2)`,
    ownerUserId === null ? [keyId] : [keyId, ownerUserId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Which of these keys are suspended (by themselves), as a set of key ids. */
export async function suspendedKeyIds(keyIds: string[]): Promise<Set<string>> {
  if (keyIds.length === 0) return new Set();
  const { rows } = await pool.query<{ api_key_id: string }>(`SELECT api_key_id FROM key_suspensions WHERE api_key_id = ANY($1)`, [keyIds]);
  return new Set(rows.map((r) => r.api_key_id));
}
