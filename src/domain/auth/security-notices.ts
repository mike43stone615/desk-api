// Emails that tell a person when something security-relevant happened on their account, so a takeover is noticed
// quickly. Sent in the background: a mail problem never affects the action being reported.
import type { FastifyRequest } from 'fastify';
import { config } from '../../config';
import { pool } from '../../db';
import { getClientIp } from '../../middleware/api-protection';
import { sendSecurityNoticeEmail } from '../../infrastructure/email/resend';

const LOOKBACK_DAYS = 90;

/** "203.0.113.7" -> "203.0"; an IPv6 address -> its first four groups. Mobile networks change the last part often. */
export function ipNeighbourhood(ip: string | null | undefined): string {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  return ip.split('.').slice(0, 2).join('.');
}

/**
 * True when this account HAS signed in before but never from this browser/app in this part of the network within the
 * last 90 days. A first-ever sign-in is not "new" (there is nothing to compare with), so signing up does not email.
 * Call it BEFORE the current sign-in is recorded.
 */
export async function isNewSignInDevice(userId: string, ip: string, userAgent: string | null): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ ip_address: string | null; user_agent: string | null }>(
      `SELECT ip_address, user_agent FROM security_events
       WHERE user_id = $1 AND event = 'signin_success' AND created_at > now() - ($2 || ' days')::interval
       ORDER BY created_at DESC LIMIT 300`,
      [userId, String(LOOKBACK_DAYS)],
    );
    if (rows.length === 0) return false;
    const here = ipNeighbourhood(ip);
    return !rows.some((r) => (r.user_agent ?? null) === userAgent && ipNeighbourhood(r.ip_address) === here);
  } catch {
    return false;
  }
}

export type SecurityNotice = 'new_sign_in' | 'password_changed' | 'password_reset' | 'api_key_created' | 'account_deleted';

function describe(kind: SecurityNotice, request: FastifyRequest, extra: string | undefined): { title: string; body: string } {
  const ua = request.headers['user-agent'];
  const where = `from ${getClientIp(request)}${typeof ua === 'string' && ua ? ` using ${ua.slice(0, 80)}` : ''}`;
  switch (kind) {
    case 'new_sign_in':
      return { title: 'New sign-in to your account', body: `Your Desk account was just signed in to ${where}. It is a browser or network we have not seen for you recently.` };
    case 'password_changed':
      return { title: 'Your password was changed', body: `The password for your Desk account was changed ${where}. Your other devices were signed out.` };
    case 'password_reset':
      return { title: 'Your password was reset', body: `The password for your Desk account was reset with an emailed link ${where}. All devices were signed out.` };
    case 'account_deleted':
      return { title: 'Your Desk account was deleted', body: `Your Desk account was deleted ${where}. Your sessions, API keys and the businesses only you owned were removed. If this was not you, reply to this email straight away.` };
    case 'api_key_created':
      return { title: 'A new API key was created', body: `An API key${extra ? ` named "${extra}"` : ''} was created for your Desk account ${where}.` };
  }
}

export function notifySecurityEvent(request: FastifyRequest, email: string, kind: SecurityNotice, extra?: string): void {
  const { title, body } = describe(kind, request, extra);
  void sendSecurityNoticeEmail(config, email, title, body, request.id).catch(() => {});
}
