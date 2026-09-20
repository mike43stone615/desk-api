// Session auth — ported from the original api/middleware/auth.ts's
// requireAuth() (Hono MiddlewareHandler) to a Fastify preHandler, plus a new
// requireAdmin() split out of what was previously inlined at the top of
// api/routes/admin.ts (`router.use('*', requireAuth(), requireAdmin())`).
import { timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './http-error';
import { authDb, authService } from '../infrastructure/auth';
import { gatewayApiKeys, looksLikeGatewayKey, type VerifiedGatewayKey } from '../domain/gateway/keys';
import { SESSION_COOKIE_NAME } from '../infrastructure/auth/session-cookie';
import { config } from '../config';
import { enforceUserRouteLimit, routeKey } from './route-limits';
import type { User } from '../interfaces/database';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: User;
    /** Set only when the request authenticated with an API Library key (not a session). */
    gatewayKey?: VerifiedGatewayKey;
  }
}

/**
 * The ONLY desk-api routes an API Library key (with the desk_api grant) may
 * call. Deliberately narrow and read-only: a leaked key must not be able to
 * change the account (password, members, drafts, businesses), mint more keys,
 * or reach /admin. Everything else answers 403 for a key even though the same
 * route works for a signed-in session. Widening this is a security decision,
 * so it lives in one readable list. Keys are "METHOD /pattern" with the /v1
 * prefix stripped.
 */
export const GATEWAY_KEY_ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  'GET /auth/session',
  'GET /setup/drafts',
  'GET /setup/drafts/:id',
  'GET /setup/businesses',
  'GET /setup/businesses/:id/members',
  'GET /setup/invites',
]);

async function authenticateWithGatewayKey(request: FastifyRequest, apiKey: string): Promise<void> {
  const verified = await gatewayApiKeys.verify(apiKey);
  if (!verified) throw new HttpError(401, 'Invalid or revoked API key.');
  if (!verified.services.has('desk_api')) {
    throw new HttpError(403, 'This API key is not enabled for the Desk API.');
  }
  const matched = routeKey(request);
  if (!matched || !GATEWAY_KEY_ALLOWED_ROUTES.has(matched)) {
    throw new HttpError(403, 'This API key cannot call this endpoint.');
  }
  const owner = await authDb.findUserById(verified.ownerUserId);
  if (!owner) throw new HttpError(401, 'Invalid or revoked API key.');
  request.currentUser = owner;
  request.gatewayKey = verified;
}

export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Bearer header first (native clients always send one; also lets a header
 * override a stale cookie in the same request), falling back to the
 * httpOnly session cookie web_app relies on when there's no header. */
export function extractSessionToken(request: FastifyRequest): string | null {
  return extractBearerToken(request) ?? request.cookies[SESSION_COOKIE_NAME] ?? null;
}

/** Fastify preHandler — resolves the calling user onto request.currentUser, or throws 401. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractSessionToken(request);
  if (!token) {
    const apiKey = request.headers['x-api-key'];
    if (!looksLikeGatewayKey(apiKey)) throw new HttpError(401, 'Authentication required.');
    await authenticateWithGatewayKey(request, apiKey);
  } else {
    const user = await authService.verifySession(token);
    if (!user) throw new HttpError(401, 'Session expired or invalid.');
    request.currentUser = user;
  }
  await enforceUserRouteLimit(request, reply);
}

/**
 * Fastify preHandler — must run after requireAuth (relies on
 * request.currentUser). Blocks business-setup actions until the account's
 * email is confirmed, so emailConfirmedAt is an enforced gate rather than a
 * tracked-but-unused field.
 */
export async function requireConfirmedEmail(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const user = request.currentUser;
  if (!user) throw new HttpError(401, 'Authentication required.');
  if (!user.emailConfirmedAt) {
    throw new HttpError(403, 'Please confirm your email address before continuing.');
  }
}

/**
 * Fastify preHandler — must run after requireAuth (relies on
 * request.currentUser). Gated by email allowlist (config.adminEmails), same
 * as the original's inline requireAdmin() in api/routes/admin.ts.
 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = request.currentUser;
  if (!user) throw new HttpError(401, 'Authentication required.');
  // Belt and braces: GATEWAY_KEY_ALLOWED_ROUTES already keeps keys off /admin,
  // but admin access must never be reachable through an API key regardless.
  if (request.gatewayKey) throw new HttpError(403, 'Admin access is not available with an API key.');
  const email = user.email.trim().toLowerCase();
  if (!config.adminEmails.includes(email)) throw new HttpError(403, 'Admin access required.');
}

/**
 * Optional Fastify preHandler gating GET /metrics and GET /docs (+
 * /docs/openapi.json) behind a shared secret sent as `x-api-key`. This is a
 * deploy-time opt-in, not a default: when METRICS_DOCS_API_KEY is unset
 * (the default), this is a no-op and both routes stay exactly as public as
 * they always have been. Set METRICS_DOCS_API_KEY to require a matching
 * header — recommended for production, alongside or instead of
 * network-level firewalling (see README.md / .env.example).
 */
export async function requireMetricsDocsKey(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const expected = config.metricsDocsApiKey;
  if (!expected) return;

  const provided = request.headers['x-api-key'];
  const providedStr = typeof provided === 'string' ? provided : '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(providedStr);
  const matches =
    expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
  if (!matches) {
    throw new HttpError(401, 'A valid x-api-key header is required to access this endpoint.');
  }
}
