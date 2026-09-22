// Session auth — ported from the original api/middleware/auth.ts's
// requireAuth() (Hono MiddlewareHandler) to a Fastify preHandler, plus a new
// requireAdmin() split out of what was previously inlined at the top of
// api/routes/admin.ts (`router.use('*', requireAuth(), requireAdmin())`).
import { timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './http-error';
import { authDb, authService } from '../infrastructure/auth';
import { gatewayApiKeys, looksLikeGatewayKey, type DeskScope, type VerifiedGatewayKey } from '../domain/gateway/keys';
import { LEGACY_SESSION_COOKIE_NAME, sessionCookieName } from '../infrastructure/auth/session-cookie';
import { config } from '../config';
import { enforceUserRouteLimit, routeKey } from './route-limits';
import { checkRateBucket, USER_BUCKET_FACTOR, getClientIp } from './api-protection';
import { ACCESS_TOKEN_PREFIX, verifyAccessToken, type VerifiedOAuthToken } from '../domain/oauth/oauth';
import { isUserSuspended } from '../domain/suspension';
import { isListedAdmin } from '../domain/admins';
import type { User } from '../interfaces/database';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: User;
    /** Set only when the request authenticated with an API Library key (not a session). */
    gatewayKey?: VerifiedGatewayKey;
    /** Set only when the request authenticated with an OAuth access token issued to a third-party app. */
    oauth?: VerifiedOAuthToken;
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
  'POST /graphql',
]);

/** Which scope each allowed route needs (see DESK_SCOPES in domain/gateway/keys.ts). */
export const GATEWAY_ROUTE_SCOPES: Readonly<Record<string, DeskScope>> = {
  'GET /auth/session': 'profile',
  'GET /setup/drafts': 'drafts',
  'GET /setup/drafts/:id': 'drafts',
  'GET /setup/businesses': 'businesses',
  'GET /setup/businesses/:id/members': 'businesses',
  'GET /setup/invites': 'businesses',
};

/**
 * An OAuth access token (issued to a third-party app the person authorized) may reach exactly what an API key may: the same
 * short read-only list, limited further to the scopes the person approved. Everything else, including every route that
 * manages the account, keys, teams, webhooks or apps, is refused whatever the scopes say.
 */
async function authenticateWithOAuthToken(request: FastifyRequest, raw: string): Promise<void> {
  const verified = await verifyAccessToken(raw);
  if (!verified) throw new HttpError(401, 'The access token is invalid, expired or revoked.', 'invalid_token');
  const matched = routeKey(request);
  if (!matched || !GATEWAY_KEY_ALLOWED_ROUTES.has(matched)) {
    throw new HttpError(403, 'An app access token cannot call this endpoint.', 'oauth_endpoint_not_allowed');
  }
  const scope = GATEWAY_ROUTE_SCOPES[matched];
  if (scope && !verified.scopes.has(scope)) throw new HttpError(403, `The app was not given the "${scope}" scope.`, 'oauth_insufficient_scope');
  const owner = await authDb.findUserById(verified.userId);
  if (!owner) throw new HttpError(401, 'The access token is invalid, expired or revoked.', 'invalid_token');
  if (await isUserSuspended(owner.id)) throw new HttpError(403, 'This account is suspended.', 'account_suspended');
  request.currentUser = owner;
  request.oauth = verified;
}

async function authenticateWithGatewayKey(request: FastifyRequest, apiKey: string): Promise<void> {
  const verified = await gatewayApiKeys.verify(apiKey);
  if (!verified) throw new HttpError(401, 'Invalid or revoked API key.', 'invalid_api_key');
  if (verified.timeProblem) throw expiredKeyError(verified.timeProblem);
  if (verified.suspended) throw new HttpError(403, 'This API key is suspended.', 'api_key_suspended');
  if (verified.allowedIps && verified.allowedIps.length > 0 && !verified.allowedIps.includes(getClientIp(request))) {
    throw new HttpError(403, 'This API key is not accepted from this address.', 'api_key_ip_not_allowed');
  }
  if (!verified.services.has('desk_api')) {
    throw new HttpError(403, 'This API key is not enabled for the Desk API.', 'api_key_service_not_enabled');
  }
  const matched = routeKey(request);
  if (!matched || !GATEWAY_KEY_ALLOWED_ROUTES.has(matched)) {
    throw new HttpError(403, 'This API key cannot call this endpoint.', 'api_key_endpoint_not_allowed');
  }
  // A key can be limited to some parts of the Desk API (the owner chose its scopes when creating it).
  const scope = GATEWAY_ROUTE_SCOPES[matched];
  if (scope && !verified.deskScopes.has(scope)) {
    throw new HttpError(403, `This API key does not include the "${scope}" scope.`, 'api_key_scope_missing');
  }
  const owner = await authDb.findUserById(verified.ownerUserId);
  if (!owner) throw new HttpError(401, 'Invalid or revoked API key.', 'invalid_api_key');
  request.currentUser = owner;
  request.gatewayKey = verified;
}

/**
 * From now on every line this request logs, including the "request completed" line, says how the caller
 * authenticated and who they are: `auth: "key"` with the key's id (never the key itself) or `auth: "session"`.
 */
export function bindAuthToLog(request: FastifyRequest, reply: FastifyReply, bindings: Record<string, unknown>): void {
  const child = request.log.child(bindings);
  request.log = child;
  // Fastify writes the completion line through the reply's logger, which is a separate reference.
  (reply as unknown as { log: typeof child }).log = child;
}

/** 401 for a key that is past its expiry date or has been idle for months. */
export function expiredKeyError(problem: 'expired' | 'idle'): HttpError {
  return problem === 'expired'
    ? new HttpError(401, 'This API key has expired. Create a new one.', 'api_key_expired')
    : new HttpError(401, 'This API key has not been used for a long time and was switched off. Create a new one.', 'api_key_idle');
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
  return extractBearerToken(request) ?? request.cookies[sessionCookieName()] ?? request.cookies[LEGACY_SESSION_COOKIE_NAME] ?? null;
}

/** Fastify preHandler — resolves the calling user onto request.currentUser, or throws 401. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractSessionToken(request);
  if (token && token.startsWith(ACCESS_TOKEN_PREFIX)) {
    await authenticateWithOAuthToken(request, token);
  } else if (!token) {
    const apiKey = request.headers['x-api-key'];
    if (!looksLikeGatewayKey(apiKey)) throw new HttpError(401, 'Authentication required.', 'authentication_required');
    await authenticateWithGatewayKey(request, apiKey);
  } else {
    const user = await authService.verifySession(token);
    if (!user) throw new HttpError(401, 'Session expired or invalid.', 'session_invalid');
    // Suspending an account ends its sessions; this catches one created in the same instant.
    if (await isUserSuspended(user.id)) throw new HttpError(403, 'This account is suspended.', 'account_suspended');
    request.currentUser = user;
  }
  bindAuthToLog(request, reply, request.gatewayKey ? { auth: 'key', keyId: request.gatewayKey.id, userId: request.currentUser!.id } : request.oauth ? { auth: 'oauth', clientId: request.oauth.clientId, userId: request.currentUser!.id } : { auth: 'session', userId: request.currentUser!.id });
  // The general limit per PERSON, on top of the one per address: a leaked session or key used from many addresses is
  // still one account with one allowance.
  const person = await checkRateBucket(`user:${request.currentUser!.id}`, USER_BUCKET_FACTOR);
  if (!person.allowed) {
    reply.header('Retry-After', '60');
    throw new HttpError(429, person.reason ?? 'Rate limit exceeded.', 'rate_limited');
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
  if (!user) throw new HttpError(401, 'Authentication required.', 'authentication_required');
  if (!user.emailConfirmedAt) {
    throw new HttpError(403, 'Please confirm your email address before continuing.', 'email_not_confirmed');
  }
}

/**
 * Fastify preHandler — must run after requireAuth (relies on
 * request.currentUser). Gated by email allowlist (config.adminEmails), same
 * as the original's inline requireAdmin() in api/routes/admin.ts.
 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = request.currentUser;
  if (!user) throw new HttpError(401, 'Authentication required.', 'authentication_required');
  // Belt and braces: GATEWAY_KEY_ALLOWED_ROUTES already keeps keys off /admin,
  // but admin access must never be reachable through an API key regardless.
  if (request.gatewayKey || request.oauth) throw new HttpError(403, 'Admin access is not available with an API key or an app token.', 'admin_not_available_for_keys');
  const email = user.email.trim().toLowerCase();
  // The owner(s) named in the server setting, or an account on the administrator list (with a confirmed address).
  if (!config.adminEmails.includes(email) && !(await isListedAdmin(user.id))) throw new HttpError(403, 'Admin access required.', 'admin_required');
  // A stolen or forgotten session must not stay an administrator for its whole 30 days: the admin tools need a
  // sign-in from the last 24 hours (a normal session still works for everything else).
  const token = extractSessionToken(request);
  const session = token ? await authService.currentSession(token) : null;
  if (!session || Date.now() - Date.parse(session.createdAt) > ADMIN_SIGNIN_MAX_AGE_MS) {
    throw new HttpError(403, 'Please sign in again to use the administrator tools.', 'admin_recent_signin_required');
  }
}

/** How recent the sign-in must be for the administrator tools. */
export const ADMIN_SIGNIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
    throw new HttpError(401, 'A valid x-api-key header is required to access this endpoint.', 'api_key_required');
  }
}
