// Session auth — ported from the original api/middleware/auth.ts's
// requireAuth() (Hono MiddlewareHandler) to a Fastify preHandler, plus a new
// requireAdmin() split out of what was previously inlined at the top of
// api/routes/admin.ts (`router.use('*', requireAuth(), requireAdmin())`).
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
 * request.currentUser). Gated by email allowlist (config.adminEmails), same
 * as the original's inline requireAdmin() in api/routes/admin.ts.
 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = request.currentUser;
  if (!user) throw new HttpError(401, 'Authentication required.');
  const email = user.email.trim().toLowerCase();
  if (!config.adminEmails.includes(email)) throw new HttpError(403, 'Admin access required.');
}
