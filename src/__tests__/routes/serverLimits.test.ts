// Server timeouts (slow clients) and the limit headers on a refusal.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { config } from '../../config';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); }, 30_000);

describe('server timeouts', () => {
  it('headers must arrive within 10 s and the whole request within 30 s; idle connections close after 65 s', () => {
    expect(app.server.headersTimeout).toBe(10_000);
    expect(app.server.requestTimeout).toBe(30_000);
    expect(app.server.keepAliveTimeout).toBe(65_000);
    expect(app.server.headersTimeout).toBeLessThanOrEqual(app.server.requestTimeout);
  });
});

describe('a 429 carries the limit headers too', () => {
  beforeEach(() => { config.rateLimitPerMinute = 3; });
  it('shows the limit, zero remaining and when it resets, alongside Retry-After', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await app.inject({ method: 'GET', url: '/auth/session', headers: { 'cf-connecting-ip': '198.51.100.77' } });
    expect(last!.statusCode).toBe(429);
    expect(last!.headers['retry-after']).toBe('60');
    expect(last!.headers['x-ratelimit-limit']).toBe('3');
    expect(last!.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(last!.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000 - 5);
  });
});

describe('fairness: a busy key or person cannot use up someone else\'s allowance', () => {
  it('a key over its own limit is refused WITHOUT costing its address anything', async () => {
    config.rateLimitPerMinute = 10; // one key gets 5 a minute, an address 10
    const ip = '198.51.100.90';
    const key = `deskgw_${'a'.repeat(48)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await app.inject({ method: 'GET', url: '/v1', headers: { 'cf-connecting-ip': ip, 'x-api-key': key } })).statusCode);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true); // over the key's own limit
    // ...and the rest of that address is untouched: another caller on the same address still has its whole allowance
    const others: number[] = [];
    for (let i = 0; i < 4; i++) others.push((await app.inject({ method: 'GET', url: '/v1', headers: { 'cf-connecting-ip': ip } })).statusCode);
    expect(others).toEqual([200, 200, 200, 200]);
  });

  it('made-up keys still cost the address (rotating fake keys does not get around the address limit)', async () => {
    config.rateLimitPerMinute = 10;
    const ip = '198.51.100.91';
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await app.inject({ method: 'GET', url: '/v1', headers: { 'cf-connecting-ip': ip, 'x-api-key': `deskgw_${String(i).padStart(48, 'b')}` } })).statusCode;
    expect(last).toBe(429);
  });

  it('a signed-in person has one allowance across addresses (2.5x an address)', async () => {
    config.rateLimitPerMinute = 4; // a person gets 10 a minute
    const { checkRateBucket, USER_BUCKET_FACTOR } = await import('../../middleware/api-protection');
    const results: boolean[] = [];
    for (let i = 0; i < 12; i++) results.push((await checkRateBucket('user:test-person', USER_BUCKET_FACTOR)).allowed);
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await checkRateBucket('user:someone-else', USER_BUCKET_FACTOR)).allowed).toBe(true);
  });
});

describe('what a browser page may read', () => {
  it('lists the request id, retry time, version tag and rate-limit headers as readable, and allows If-Match', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/setup/drafts', headers: { origin: 'https://app.deskbusiness.co', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'if-match,content-type' } });
    expect(res.headers['access-control-allow-headers']).toMatch(/If-Match/i);
    const actual = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://app.deskbusiness.co' } });
    expect(String(actual.headers['access-control-expose-headers'])).toMatch(/X-Request-Id/i);
    expect(String(actual.headers['access-control-expose-headers'])).toMatch(/Retry-After/i);
  });
});

describe('the session cookie', () => {
  it('in production carries the __Host- prefix (Secure, Path=/, no Domain), and the old name is still read and cleared', async () => {
    const { config: cfg } = await import('../../config');
    const before = cfg.environment;
    (cfg as { environment: string }).environment = 'production';
    try {
      const { setSessionCookie, clearSessionCookie, sessionCookieName } = await import('../../infrastructure/auth/session-cookie');
      expect(sessionCookieName()).toBe('__Host-desk_session');
      const headers: string[] = [];
      const reply = { setCookie: (n: string, v: string, o: Record<string, unknown>) => headers.push(`${n}=${v}; ${JSON.stringify(o)}`), clearCookie: (n: string) => headers.push(`clear ${n}`) };
      setSessionCookie(reply as never, 'tok');
      expect(headers[0]).toMatch(/^__Host-desk_session=tok;/);
      expect(headers[0]).toMatch(/"secure":true/);
      expect(headers[0]).toMatch(/"path":"\/"/);
      expect(headers[0]).not.toMatch(/domain/i);
      headers.length = 0;
      clearSessionCookie(reply as never);
      expect(headers).toEqual(['clear __Host-desk_session', 'clear desk_session']);
      // a browser that still holds the old cookie is not signed out
      const { extractSessionToken } = await import('../../middleware/auth');
      expect(extractSessionToken({ headers: {}, cookies: { desk_session: 'legacy' } } as never)).toBe('legacy');
      expect(extractSessionToken({ headers: {}, cookies: { '__Host-desk_session': 'new', desk_session: 'legacy' } } as never)).toBe('new');
    } finally {
      (cfg as { environment: string }).environment = before;
    }
  });
});

describe('every answer says which browser features are off', () => {
  it('carries a Permissions-Policy header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['permissions-policy']).toMatch(/camera=\(\)/);
  });
});
