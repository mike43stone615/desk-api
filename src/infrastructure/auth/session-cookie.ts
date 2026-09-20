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

/** The name every cookie used until September 2026; still accepted (and cleared) so nobody is signed out by the change. */
export const LEGACY_SESSION_COOKIE_NAME = 'desk_session';
/**
 * In production the cookie carries the `__Host-` prefix: the browser then refuses to store it unless it is Secure, has
 * Path=/ and NO Domain attribute, so a sibling site (app., oracle., compliance-api.) can never plant or overwrite a
 * session cookie for the API. (Locally there is no HTTPS, and the prefix cannot be used.)
 */
export function sessionCookieName(): string {
  return config.environment === 'production' ? `__Host-${LEGACY_SESSION_COOKIE_NAME}` : LEGACY_SESSION_COOKIE_NAME;
}
/** Kept for callers that only need "the" name; same as sessionCookieName(). */
export const SESSION_COOKIE_NAME = LEGACY_SESSION_COOKIE_NAME;

/** No Domain attribute: defaults to api.deskbusiness.co exactly, which is
 * all that's needed -- every request that must carry this cookie already
 * goes to that host. SameSite=Lax is enough for CSRF protection here
 * without a separate token: app.deskbusiness.co and api.deskbusiness.co
 * are cross-origin but same-site (same registrable domain,
 * deskbusiness.co), so Lax still sends it on cross-origin fetches between
 * them, while blocking it on requests that originate from a genuinely
 * different site. */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: config.environment === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionDurationHours * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  // A __Host- cookie can only be replaced or deleted by a Set-Cookie that itself follows the prefix rules (Secure, Path=/).
  reply.clearCookie(sessionCookieName(), { path: '/', secure: config.environment === 'production', httpOnly: true, sameSite: 'lax' });
  reply.clearCookie(LEGACY_SESSION_COOKIE_NAME, { path: '/' }); // and the pre-prefix name, if the browser still has one
}
