// httpOnly session cookie -- an alternative to the Authorization bearer
// header for browser clients (web_app), which previously stored that same
// token in localStorage where any script on the page could read it. Native
// clients (the Flutter app's mobile/desktop builds) are unaffected: they
// keep using the bearer header with a token from flutter_secure_storage,
// exactly as before. Both mechanisms carry the same opaque, server-verified
// session token -- this cookie is not a separate credential, just a
// different way to deliver the same one to the same requireAuth() check.
import type { FastifyReply } from 'fastify';
import { config } from '../../config';

export const SESSION_COOKIE_NAME = 'desk_session';

/** No Domain attribute: defaults to api.deskbusiness.co exactly, which is
 * all that's needed -- every request that must carry this cookie already
 * goes to that host. SameSite=Lax is enough for CSRF protection here
 * without a separate token: app.deskbusiness.co and api.deskbusiness.co
 * are cross-origin but same-site (same registrable domain,
 * deskbusiness.co), so Lax still sends it on cross-origin fetches between
 * them, while blocking it on requests that originate from a genuinely
 * different site. */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.environment === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionDurationHours * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}
