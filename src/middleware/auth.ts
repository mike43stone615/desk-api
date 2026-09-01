// Session auth — ported from the original api/middleware/auth.ts's
// requireAuth() (Hono MiddlewareHandler) to a Fastify preHandler, plus a new
// requireAdmin() split out of what was previously inlined at the top of
// api/routes/admin.ts (`router.use('*', requireAuth(), requireAdmin())`).
import { timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './http-error';
import { authService } from '../infrastructure/auth';
import { config } from '../config';
import type { User } from '../interfaces/database';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: User;
  }
}

export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Fastify preHandler — resolves the calling user onto request.currentUser, or throws 401. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request);
  if (!token) throw new HttpError(401, 'Authentication required.');
  const user = await authService.verifySession(token);
  if (!user) throw new HttpError(401, 'Session expired or invalid.');
  request.currentUser = user;
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
