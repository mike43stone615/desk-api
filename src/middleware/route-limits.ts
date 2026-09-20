// Per-route limits for the few routes where the general per-IP limit (120/minute) is far too generous:
// routes that send email, mint credentials, or guess at tokens. Two kinds:
//  - CALLER rules (before the handler): per client IP, and per email address in the body, so one victim's inbox cannot
//    be flooded from many addresses;
//  - USER rules (right after a request is authenticated): per signed-in account, so a leaked key or session cannot be
//    used to mint credentials or send invitations in bulk.
// Fixed windows. Shared through Redis when configured (so every copy of the service agrees), in memory otherwise.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, problemBody } from './http-error';
import { getRedis } from './redis-client';
import { getClientIp } from './api-protection';

const HOUR = 60 * 60 * 1000;

export interface Limit {
  /** Stable name; part of the counter key. */
  name: string;
  max: number;
  windowMs: number;
  /** What the caller is told they hit. */
  what: string;
}

const perHour = (name: string, max: number, what: string): Limit => ({ name, max, windowMs: HOUR, what });

/** "METHOD /pattern" (without /v1) -> limits per client IP and per email address in the request body. */
export const CALLER_RULES: Record<string, { ip: Limit; email?: Limit }> = {
  'POST /auth/password-reset/request': {
    ip: perHour('pwreset-req-ip', 5, 'password-reset requests'),
    email: perHour('pwreset-req-email', 3, 'password-reset requests for this address'),
  },
  'POST /auth/email-confirmation/request': {
    ip: perHour('emailconf-req-ip', 5, 'confirmation-email requests'),
    email: perHour('emailconf-req-email', 3, 'confirmation-email requests for this address'),
  },
  'POST /auth/password-reset/confirm': { ip: perHour('pwreset-confirm-ip', 20, 'password-reset attempts') },
  'POST /auth/email-confirmation/confirm': { ip: perHour('emailconf-confirm-ip', 20, 'confirmation attempts') },
  'POST /integrations/market-research/analyze': { ip: perHour('market-analyze-ip', 30, 'market analyses') },
};

/** "METHOD /pattern" (without /v1) -> limit per signed-in account. */
export const USER_RULES: Record<string, Limit> = {
  'POST /gateway/api-keys': perHour('key-create', 10, 'API keys created'),
  'DELETE /gateway/api-keys/:id': perHour('key-revoke', 30, 'API keys revoked'),
  'POST /setup/businesses/:id/members': perHour('invite', 20, 'invitations sent'),
  'POST /setup/drafts': perHour('draft-create', 30, 'drafts created'),
  'POST /setup/drafts/:id/complete': perHour('draft-complete', 20, 'businesses created'),
  'POST /auth/password': perHour('password-change', 10, 'password changes'),
};

/** "METHOD /pattern" for the matched route, with any /v1 prefix removed; null when no route matched. */
export function routeKey(request: FastifyRequest): string | null {
  const pattern = request.routeOptions?.url;
  if (!pattern) return null;
  const unversioned = pattern === '/v1' ? '/' : pattern.startsWith('/v1/') ? pattern.slice(3) : pattern;
  return `${request.method} ${unversioned}`;
}

// Off in the test suite (which signs up and resets far more often than any real person), unless a test turns it on.
let enabledInTests = false;
export function setRouteLimitsEnabledForTests(on: boolean): void {
  enabledInTests = on;
  memory.clear();
}
function enabled(): boolean {
  return process.env.NODE_ENV !== 'test' || enabledInTests;
}

interface Counter {
  count: number;
  resetAt: number;
}
const memory = new Map<string, Counter>();

function prune(now: number): void {
  for (const [k, c] of memory) if (c.resetAt <= now) memory.delete(k);
}

/** Counts one hit. Returns 0 when allowed, otherwise the seconds until the window resets. */
export async function hit(limit: Limit, subject: string, now = Date.now()): Promise<number> {
  const key = `rlr:${limit.name}:${subject}`;
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, limit.windowMs);
      if (count <= limit.max) return 0;
      const ttl = await redis.pttl(key);
      return Math.max(1, Math.ceil((ttl > 0 ? ttl : limit.windowMs) / 1000));
    } catch {
      // Redis trouble must not switch protection off: fall through to the in-memory counter.
    }
  }
  prune(now);
  const existing = memory.get(key);
  if (!existing) {
    memory.set(key, { count: 1, resetAt: now + limit.windowMs });
    return 0;
  }
  existing.count += 1;
  return existing.count <= limit.max ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
}

function message(limit: Limit, retryAfterSeconds: number): string {
  const wait = retryAfterSeconds >= 120 ? `${Math.ceil(retryAfterSeconds / 60)} minutes` : `${retryAfterSeconds} seconds`;
  return `Too many ${limit.what}. Please try again in ${wait}.`;
}

function bodyEmail(request: FastifyRequest): string | null {
  const body = request.body as { email?: unknown } | null | undefined;
  if (!body || typeof body !== 'object' || typeof body.email !== 'string') return null;
  const email = body.email.trim().toLowerCase();
  return email && email.length <= 254 ? email : null;
}

/** Called by requireAuth once the caller is known: applies the per-account limit for this route, if it has one. */
export async function enforceUserRouteLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!enabled() || !request.currentUser) return;
  const key = routeKey(request);
  const limit = key ? USER_RULES[key] : undefined;
  if (!limit) return;
  const wait = await hit(limit, request.currentUser.id);
  if (wait > 0) {
    reply.header('Retry-After', String(wait));
    throw new HttpError(429, message(limit, wait));
  }
}

export function registerRouteLimits(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!enabled()) return;
    const key = routeKey(request);
    const rule = key ? CALLER_RULES[key] : undefined;
    if (!rule) return;

    const refuse = (limit: Limit, wait: number) =>
      reply
        .status(429)
        .header('Content-Type', 'application/problem+json')
        .header('Retry-After', String(wait))
        .send(problemBody(request.url, 429, message(limit, wait), { retryAfterSeconds: wait }));

    const ipWait = await hit(rule.ip, getClientIp(request));
    if (ipWait > 0) return refuse(rule.ip, ipWait);

    const email = rule.email ? bodyEmail(request) : null;
    if (rule.email && email) {
      const emailWait = await hit(rule.email, email);
      if (emailWait > 0) return refuse(rule.email, emailWait);
    }
  });
}
