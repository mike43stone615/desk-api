// 4-tier rate limiting (minute/hour/day/month), matching compliance-os's
// shape (compliance-os/src/middleware/api-protection.ts's RATE_LIMIT_CONFIG
// + redisCheck/memCheck). Unlike registry-api/market-validation-api/
// compliance-os, this service has no API-key concept — every caller is
// either anonymous or session-authenticated — so bucketing is IP-only here
// (no x-api-key bucket branch). Admin-route gating lives separately in
// middleware/auth.ts's requireAdmin(), since desk-api's admin access is
// session + email-allowlist, not a shared secret header.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { getRedis } from './redis-client';
import { config } from '../config';

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  remaining: number;
  resetAt: number;
}

// ── In-memory fallback ────────────────────────────────────────────────────────

interface BucketState {
  minuteTokens: number;
  hourTokens: number;
  dayTokens: number;
  monthTokens: number;
  lastMinuteReset: number;
  lastHourReset: number;
  lastDayReset: number;
  lastMonthReset: number;
  lastAccess: number;
}

const memBuckets = new Map<string, BucketState>();

// Every unique caller (IP, since this service has no API-key bucketing) gets
// a permanent entry with no eviction - a slow, guaranteed leak on any run
// without Redis configured, worse under scanning/probing traffic (confirmed
// live: no cap, no cleanup interval anywhere). A caller idle for a full day
// has necessarily had every one of its windows (minute/hour/day) refill
// already, so evicting it loses no real rate-limit state - the next request
// just gets a fresh bucket, identical to a brand-new caller.
const BUCKET_IDLE_EVICTION_MS = 24 * 60 * 60 * 1000;
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of memBuckets) {
    if (now - bucket.lastAccess > BUCKET_IDLE_EVICTION_MS) memBuckets.delete(key);
  }
}, 15 * 60 * 1000);
sweepInterval.unref();

function memGetOrCreate(key: string): BucketState {
  let b = memBuckets.get(key);
  if (!b) {
    const now = Date.now();
    b = {
      minuteTokens: config.rateLimitPerMinute,
      hourTokens: config.rateLimitPerHour,
      dayTokens: config.rateLimitDaily,
      monthTokens: config.rateLimitMonthly,
      lastMinuteReset: now,
      lastHourReset: now,
      lastDayReset: now,
      lastMonthReset: now,
      lastAccess: now,
    };
    memBuckets.set(key, b);
  } else {
    b.lastAccess = Date.now();
  }
  return b;
}

function memCheck(key: string): RateLimitResult {
  const b = memGetOrCreate(key);
  const now = Date.now();
  if (now - b.lastMinuteReset > 60_000) {
    b.minuteTokens = config.rateLimitPerMinute;
    b.lastMinuteReset = now;
  }
  if (now - b.lastHourReset > 3_600_000) {
    b.hourTokens = config.rateLimitPerHour;
    b.lastHourReset = now;
  }
  if (now - b.lastDayReset > 86_400_000) {
    b.dayTokens = config.rateLimitDaily;
    b.lastDayReset = now;
  }
  if (now - b.lastMonthReset > 2_592_000_000) {
    b.monthTokens = config.rateLimitMonthly;
    b.lastMonthReset = now;
  }
  const resetAt = Math.ceil((b.lastMinuteReset + 60_000) / 1000);
  if (b.minuteTokens <= 0) return { allowed: false, reason: 'Rate limit exceeded (per-minute).', remaining: 0, resetAt };
  if (b.hourTokens <= 0) return { allowed: false, reason: 'Rate limit exceeded (per-hour).', remaining: 0, resetAt };
  if (b.dayTokens <= 0) return { allowed: false, reason: 'Daily quota exceeded.', remaining: 0, resetAt };
  if (b.monthTokens <= 0) return { allowed: false, reason: 'Monthly quota exceeded.', remaining: 0, resetAt };
  b.minuteTokens--;
  b.hourTokens--;
  b.dayTokens--;
  b.monthTokens--;
  return { allowed: true, remaining: b.minuteTokens, resetAt };
}

// ── Redis sliding window ──────────────────────────────────────────────────────

async function redisCheck(key: string): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) return memCheck(key);

  const now = Date.now();
  const windows: Array<{ key: string; limit: number; windowMs: number; label: string }> = [
    { key: `rl:min:${key}`, limit: config.rateLimitPerMinute, windowMs: 60_000, label: 'per-minute' },
    { key: `rl:hr:${key}`, limit: config.rateLimitPerHour, windowMs: 3_600_000, label: 'per-hour' },
    { key: `rl:day:${key}`, limit: config.rateLimitDaily, windowMs: 86_400_000, label: 'daily' },
    { key: `rl:mo:${key}`, limit: config.rateLimitMonthly, windowMs: 2_592_000_000, label: 'monthly' },
  ];

  let minuteRemaining = 0;
  let minuteResetAt = Math.ceil((now + 60_000) / 1000);

  for (const w of windows) {
    try {
      const pipe = redis.pipeline();
      pipe.zremrangebyscore(w.key, 0, now - w.windowMs);
      pipe.zcard(w.key);
      pipe.zadd(w.key, now, `${now}-${randomUUID()}`);
      pipe.pexpire(w.key, w.windowMs);
      const results = await pipe.exec();
      const count = (results?.[1]?.[1] as number) ?? 0;
      if (w.label === 'per-minute') {
        minuteRemaining = Math.max(0, w.limit - count - 1);
        minuteResetAt = Math.ceil((now + w.windowMs) / 1000);
      }
      if (count >= w.limit) {
        return {
          allowed: false,
          reason: `Rate limit exceeded (${w.label}).`,
          remaining: 0,
          resetAt: Math.ceil((now + w.windowMs) / 1000),
        };
      }
    } catch {
      // Redis error — fall through to allow (fail open on infra failure).
    }
  }

  return { allowed: true, remaining: minuteRemaining, resetAt: minuteResetAt };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the client IP, honoring X-Forwarded-For only up to the configured
 * number of trusted reverse-proxy hops (TRUSTED_PROXY_COUNT). With the
 * default of 0, X-Forwarded-For is ignored entirely and request.ip is used.
 */
export function getClientIp(request: FastifyRequest): string {
  // cf-connecting-ip is set by Cloudflare's edge itself for every request
  // that actually passes through Cloudflare, and it overwrites (rather than
  // appends to) any value a client tries to send under that same header
  // name — so unlike X-Forwarded-For, no hop-counting is needed to avoid
  // trusting a caller-supplied value. This is why request.ip alone
  // (cross-31) collapsed every visitor to the same address behind this
  // platform's Cloudflare Tunnel: the raw TCP connection Fastify sees is
  // always the local cloudflared process, never the real visitor.
  const cfConnectingIp = request.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.length > 0) {
    return cfConnectingIp;
  }

  const trustedHops = config.trustedProxyCount;
  if (trustedHops > 0) {
    const fwd = request.headers['x-forwarded-for'];
    if (typeof fwd === 'string') {
      const hops = fwd.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length > 0) {
        const index = Math.max(0, hops.length - trustedHops);
        return hops[index];
      }
    }
  }
  return request.ip ?? 'unknown';
}

/**
 * Strips the query string and a leading /v1 versioning prefix, so
 * path-matching applies uniformly whether a route was hit unprefixed or
 * under /v1 — routes are registered both ways in app.ts.
 */
export function normalizePath(url: string): string {
  const path = url.split('?')[0];
  if (path === '/v1') return '/';
  if (path.startsWith('/v1/')) return path.slice(3);
  return path;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerApiProtection(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = normalizePath(request.url);
    if (path === '/health' || path === '/metrics') return;

    const bucketKey = `ip:${getClientIp(request)}`;
    const result = await redisCheck(bucketKey);
    if (!result.allowed) {
      return reply.status(429).send({ error: result.reason, retryAfterSeconds: 60 });
    }

    reply.header('X-RateLimit-Limit', String(config.rateLimitPerMinute));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    reply.header('X-RateLimit-Reset', String(result.resetAt));
  });
}
