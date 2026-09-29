// Emails that tell a person when something security-relevant happened on their account, so a takeover is noticed
// quickly. Sent in the background: a mail problem never affects the action being reported.
import type { FastifyRequest } from 'fastify';
import { config } from '../../config';
import { pool } from '../../db';
import { sendSecurityNoticeEmail, libraryBase } from '../../infrastructure/email/resend';
import { emailLinkBase } from '../email/link-base';

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

export type SecurityNotice = 'new_sign_in' | 'password_changed' | 'password_reset' | 'api_key_created' | 'api_key_rotated' | 'account_deleted' | 'two_factor_enabled' | 'two_factor_disabled';

function describe(kind: SecurityNotice, extra: string | undefined): { title: string; body: string; showAction?: boolean; note?: string } {
  switch (kind) {
    case 'new_sign_in':
      return { title: 'New sign-in to your account', body: 'Your Desk account was just signed in from a browser or network we have not seen for you recently.' };
    case 'password_changed':
      return { title: 'Your password was changed', body: 'The password for your Desk account was changed. Your other devices were signed out.' };
    case 'password_reset':
      return { title: 'Your password was reset', body: 'The password for your Desk account was reset.' };
    case 'account_deleted':
      // No button (the account is gone), and no accurate "reset your password" advice can follow — there is nothing
      // left to sign into.
      return {
        title: 'Your Desk account was deleted',
        body: 'Your Desk account has been permanently deleted, along with your sessions, API keys, and the businesses only you owned.',
        showAction: false,
        note: 'If this was not you, contact support right away.',
      };
    case 'api_key_created':
      // Purely informational — there's nothing to act on unless the person signs in anyway, so no button either.
      return { title: 'A new API key was created', body: `An API key${extra ? ` named "${extra}"` : ''} was created for your Desk account.`, showAction: false };
    case 'api_key_rotated':
      return { title: 'An API key was rotated', body: `An API key${extra ? ` named "${extra}"` : ''} was given a new secret for your Desk account. Its old secret stopped working immediately.`, showAction: false };
    case 'two_factor_enabled':
      return { title: 'Two-factor authentication turned on', body: 'Two-factor authentication was turned on for your Desk account. A code from your authenticator app is now needed to sign in.' };
    case 'two_factor_disabled':
      return {
        title: 'Two-factor authentication turned off',
        body: 'Two-factor authentication was turned off for your Desk account. Signing in now needs only your password.',
        note: 'If this was not you, turn two-factor authentication back on and change your password right away, and sign out all devices from the page above. You cannot unsubscribe from security notices.',
      };
  }
}

/** Where the "Sign in" button (and, for a buttonless notice, its logo) should point. API keys only ever come from
    the API Library, whichever app the triggering request's Origin says — everything else follows the request. */
function actionUrlFor(kind: SecurityNotice, request: FastifyRequest): string {
  if (kind === 'api_key_created' || kind === 'api_key_rotated') return `${libraryBase()}/login`;
  const base = emailLinkBase(request);
  return base === config.appBaseUrl ? `${base}/account/sessions` : `${base}/login`;
}

export function notifySecurityEvent(request: FastifyRequest, email: string, kind: SecurityNotice, extra?: string): void {
  const { title, body, showAction, note } = describe(kind, extra);
  void sendSecurityNoticeEmail(config, email, title, body, request.id, { showAction, actionUrl: actionUrlFor(kind, request), note }).catch(() => {});
}
