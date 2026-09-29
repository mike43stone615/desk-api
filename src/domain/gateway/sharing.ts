// Sharing one API key with another person: a much smaller replacement for the old Teams model (one owner, a
// handful of individually-invited viewers, no roles or hierarchy — see migration 0029). A share is only created for
// an email that already has a confirmed Desk account; its recipient accepts or declines it themselves from "Key
// shared with me" on the API Library page. An accepted share lets its holder see the key's usage and settings —
// never its secret, and never switch it off, rotate it, revoke it, or add/remove an API on it; only the owner can
// (see the plain owner_user_id check next to every management route in routes/gateway.ts).
import { randomUUID } from 'crypto';
import { pool } from '../../db';
import { gatewayApiKeys, type GatewayKeySummary } from './keys';

/** Bounds how many people one key can be shared with at once. */
export const MAX_SHARES_PER_KEY = 20;

export type ShareErrorCode = 'not_found' | 'already_owner' | 'no_account' | 'limit_reached';

export class ShareError extends Error {
  constructor(
    public readonly code: ShareErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

const NOW_SQL = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

interface PersonInfo { email: string; firstName: string; lastName: string }

export interface KeyShareRow {
  id: string;
  apiKeyId: string;
  acceptedAt: string | null;
  createdAt: string;
  sharedWith: PersonInfo;
}

export type SharedKeySummary = GatewayKeySummary & { shareId: string; shareAcceptedAt: string | null; owner: PersonInfo | null };

async function ownerOf(keyId: string): Promise<string | null> {
  const { rows } = await pool.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM gateway_api_keys WHERE id = $1 AND revoked_at IS NULL`, [keyId]);
  return rows[0]?.owner_user_id ?? null;
}

export const keyShares = {
  /** Invites an email address (must already have a confirmed Desk account, and not be the owner) to view one of the caller's own keys. */
  async share(ownerUserId: string, keyId: string, email: string): Promise<KeyShareRow> {
    const owner = await ownerOf(keyId);
    if (owner !== ownerUserId) throw new ShareError('not_found', 'API key not found.');

    const address = email.trim().toLowerCase();
    const { rows: userRows } = await pool.query<{ id: string; email: string; first_name: string; last_name: string }>(
      `SELECT id, email, first_name, last_name FROM users WHERE lower(email) = lower($1) AND email_confirmed_at IS NOT NULL`,
      [address],
    );
    const target = userRows[0];
    if (!target) throw new ShareError('no_account', 'No Desk account with a confirmed email address at that address.');
    if (target.id === ownerUserId) throw new ShareError('already_owner', 'You already own this key.');

    const { rows: countRows } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM gateway_key_shares WHERE api_key_id = $1`, [keyId]);
    if (Number(countRows[0]?.n ?? 0) >= MAX_SHARES_PER_KEY) throw new ShareError('limit_reached', `A key can be shared with at most ${MAX_SHARES_PER_KEY} people.`);

    // Re-sharing with someone who already declined (or was removed) just invites them again, fresh.
    const { rows } = await pool.query<{ id: string; accepted_at: string | null; created_at: string }>(
      `INSERT INTO gateway_key_shares (id, api_key_id, shared_with_user_id, invited_by_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (api_key_id, shared_with_user_id) DO UPDATE SET invited_by_user_id = excluded.invited_by_user_id
       RETURNING id, accepted_at, created_at`,
      [randomUUID(), keyId, target.id, ownerUserId],
    );
    const row = rows[0];
    return { id: row.id, apiKeyId: keyId, acceptedAt: row.accepted_at, createdAt: row.created_at, sharedWith: { email: target.email, firstName: target.first_name, lastName: target.last_name } };
  },

  /** Everyone a key has been shared with (pending and accepted), for the owner's own "invite +" popup. */
  async listForKey(ownerUserId: string, keyId: string): Promise<KeyShareRow[]> {
    const owner = await ownerOf(keyId);
    if (owner !== ownerUserId) throw new ShareError('not_found', 'API key not found.');
    const { rows } = await pool.query<{ id: string; accepted_at: string | null; created_at: string; email: string; first_name: string; last_name: string }>(
      `SELECT s.id, s.accepted_at, s.created_at, u.email, u.first_name, u.last_name
         FROM gateway_key_shares s JOIN users u ON u.id = s.shared_with_user_id
        WHERE s.api_key_id = $1 ORDER BY s.created_at ASC`,
      [keyId],
    );
    return rows.map((r) => ({ id: r.id, apiKeyId: keyId, acceptedAt: r.accepted_at, createdAt: r.created_at, sharedWith: { email: r.email, firstName: r.first_name, lastName: r.last_name } }));
  },

  /** Keys shared with this person, pending and accepted, newest first — same card shape as "Your keys" plus who owns it. */
  async listSharedWithMe(userId: string): Promise<SharedKeySummary[]> {
    const { rows } = await pool.query<{ id: string; api_key_id: string; accepted_at: string | null; created_at: string }>(
      `SELECT id, api_key_id, accepted_at, created_at FROM gateway_key_shares WHERE shared_with_user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    const out: SharedKeySummary[] = [];
    for (const r of rows) {
      const summary = await gatewayApiKeys.summaryOf(r.api_key_id);
      if (!summary) continue; // the key was revoked since; the nightly sweep clears the orphaned share row
      const { rows: ownerRows } = await pool.query<{ email: string; first_name: string; last_name: string }>(
        `SELECT u.email, u.first_name, u.last_name FROM users u JOIN gateway_api_keys k ON k.owner_user_id = u.id WHERE k.id = $1`,
        [r.api_key_id],
      );
      const o = ownerRows[0];
      out.push({ ...summary, shareId: r.id, shareAcceptedAt: r.accepted_at, owner: o ? { email: o.email, firstName: o.first_name, lastName: o.last_name } : null });
    }
    return out;
  },

  /** Accepts a pending share. Returns the key and its owner (for the owner's "someone joined" webhook event). */
  async accept(userId: string, shareId: string): Promise<{ apiKeyId: string; ownerUserId: string | null }> {
    const res = await pool.query<{ api_key_id: string }>(`UPDATE gateway_key_shares SET accepted_at = ${NOW_SQL} WHERE id = $1 AND shared_with_user_id = $2 AND accepted_at IS NULL RETURNING api_key_id`, [shareId, userId]);
    if (!res.rowCount) throw new ShareError('not_found', 'Invitation not found.');
    const apiKeyId = res.rows[0].api_key_id;
    return { apiKeyId, ownerUserId: await ownerOf(apiKeyId) };
  },

  /** Declines a pending share, or removes yourself from one you'd already accepted. Returns the key and its owner
      (for the owner's "someone was removed" webhook event). */
  async decline(userId: string, shareId: string): Promise<{ apiKeyId: string; ownerUserId: string | null }> {
    const res = await pool.query<{ api_key_id: string }>(`DELETE FROM gateway_key_shares WHERE id = $1 AND shared_with_user_id = $2 RETURNING api_key_id`, [shareId, userId]);
    if (!res.rowCount) throw new ShareError('not_found', 'Share not found.');
    const apiKeyId = res.rows[0].api_key_id;
    return { apiKeyId, ownerUserId: await ownerOf(apiKeyId) };
  },

  /** The owner removes someone a key was shared with (pending or already accepted). */
  async removeByOwner(ownerUserId: string, keyId: string, shareId: string): Promise<void> {
    const owner = await ownerOf(keyId);
    if (owner !== ownerUserId) throw new ShareError('not_found', 'API key not found.');
    const res = await pool.query(`DELETE FROM gateway_key_shares WHERE id = $1 AND api_key_id = $2`, [shareId, keyId]);
    if (!res.rowCount) throw new ShareError('not_found', 'Share not found.');
  },

  /** Whether the person may VIEW (not manage) this key: its owner, or someone it's been shared with who accepted.
      Returns the owner's user id (what usage/detail queries key on), or null. */
  async viewerOwnerOf(userId: string, keyId: string): Promise<string | null> {
    const owner = await ownerOf(keyId);
    if (!owner) return null;
    if (owner === userId) return owner;
    const { rows } = await pool.query(`SELECT 1 FROM gateway_key_shares WHERE api_key_id = $1 AND shared_with_user_id = $2 AND accepted_at IS NOT NULL`, [keyId, userId]);
    return rows[0] ? owner : null;
  },
};
