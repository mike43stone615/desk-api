// Stores security-relevant events (migration 0014) so they outlive the log and can be shown to the account's owner.
// Fire-and-forget like the mutation audit: a failure to record must never break the action being recorded.
import { randomUUID } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { pool } from '../../db';
import { getClientIp } from '../../middleware/api-protection';

export const SECURITY_EVENT_RETENTION_DAYS = 180;

/** meta.userId / meta.account (an email fingerprint) become columns; everything else is kept as detail. */
export function recordSecurityEvent(
  request: FastifyRequest,
  event: string,
  outcome: 'ok' | 'error',
  meta: Record<string, string> = {},
): void {
  const { userId, account, ...detail } = meta;
  const ua = request.headers['user-agent'];
  Promise.resolve(
    pool.query(
      `INSERT INTO security_events (id, user_id, subject, event, outcome, ip_address, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        userId ?? request.currentUser?.id ?? null,
        account ?? null,
        event,
        outcome,
        getClientIp(request),
        typeof ua === 'string' ? ua.slice(0, 255) : null,
        Object.keys(detail).length ? JSON.stringify(detail) : null,
      ],
    ),
  ).catch(() => {});
}

export interface SecurityEventRow {
  id: string;
  event: string;
  outcome: 'ok' | 'error';
  ip_address: string | null;
  user_agent: string | null;
  created_at: string | Date;
}

/** The person's own recent events, newest first: what happened on their account, plus failed sign-ins for their address. */
export async function listSecurityEvents(userId: string, subject: string, limit = 50): Promise<SecurityEventRow[]> {
  const { rows } = await pool.query<SecurityEventRow>(
    `SELECT id, event, outcome, ip_address, user_agent, created_at FROM security_events
     WHERE user_id = $1 OR subject = $2 ORDER BY created_at DESC LIMIT $3`,
    [userId, subject, limit],
  );
  return rows;
}

export async function deleteExpiredSecurityEvents(): Promise<void> {
  await pool.query(`DELETE FROM security_events WHERE created_at < now() - ($1 || ' days')::interval`, [String(SECURITY_EVENT_RETENTION_DAYS)]);
}
