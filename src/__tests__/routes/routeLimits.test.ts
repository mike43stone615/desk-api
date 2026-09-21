// Per-route limits: routes that send email, mint credentials or guess tokens are limited far below the general limit.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
let fakeRedis: unknown = null;
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => fakeRedis, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { hit, setRouteLimitsEnabledForTests, type Limit } from '../../middleware/route-limits';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
const savedSecret = config.gatewayKeyEncryptionSecret;

beforeAll(async () => {
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
  app = await buildApp();
});
afterAll(() => {
  config.gatewayKeyEncryptionSecret = savedSecret;
  setRouteLimitsEnabledForTests(false);
});
beforeEach(() => {
  fakeRedis = null;
  setRouteLimitsEnabledForTests(true);
});

let n = 0;
function seedUser() {
  n += 1;
  const id = `rl-user-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, {
    id, email: `${id}@example.com`, password_hash: 'x', first_name: 'A', last_name: 'B',
    email_confirmed_at: now, created_at: now, updated_at: now,
  });
  const token = `rl-token-${n}`;
  fakeDb.seedSession(token, { id: `s-${id}`, user_id: id, token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
  return { id, headers: { authorization: `Bearer ${token}` } };
}

const resetFrom = (ip: string, email: string, prefix = '') =>
  app.inject({ method: 'POST', url: `${prefix}/auth/password-reset/request`, headers: { 'cf-connecting-ip': ip }, payload: { email } });

describe('caller limits on the email and token routes', () => {
  it('a fifth reset request from one address is fine and a sixth is refused, with when to retry', async () => {
    for (let i = 0; i < 5; i++) expect((await resetFrom('198.51.100.1', `who${i}@example.com`)).statusCode).toBe(200);
    const res = await resetFrom('198.51.100.1', 'who5@example.com');
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(3000);
    expect(JSON.parse(res.body)).toMatchObject({ status: 429, title: 'Too Many Requests' });
    expect(JSON.parse(res.body).detail).toMatch(/password-reset requests/);
  });

  it('another address is not affected by the first one', async () => {
    for (let i = 0; i < 6; i++) await resetFrom('198.51.100.2', `x${i}@example.com`);
    expect((await resetFrom('198.51.100.3', 'fresh@example.com')).statusCode).toBe(200);
  });

  it('one inbox cannot be flooded from many addresses: the fourth request for it is refused, in any letter case', async () => {
    expect((await resetFrom('203.0.113.1', 'victim@example.com')).statusCode).toBe(200);
    expect((await resetFrom('203.0.113.2', 'VICTIM@example.com')).statusCode).toBe(200);
    expect((await resetFrom('203.0.113.3', ' Victim@Example.com ')).statusCode).toBe(200);
    const res = await resetFrom('203.0.113.4', 'victim@example.com');
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).detail).toMatch(/for this address/);
  });

  it('an address that has no account is limited exactly the same, so the limit reveals nothing', async () => {
    fakeDb.users.set('real', {
      id: 'real', email: 'real@example.com', password_hash: 'x', first_name: 'A', last_name: 'B',
      email_confirmed_at: new Date().toISOString(), created_at: '', updated_at: '',
    });
    const outcomes = async (email: string) => {
      const out: number[] = [];
      for (let i = 0; i < 4; i++) out.push((await resetFrom(`192.0.2.${email.length}${i}`, email)).statusCode);
      return out;
    };
    expect(await outcomes('real@example.com')).toEqual([200, 200, 200, 429]);
    expect(await outcomes('ghost@example.com')).toEqual([200, 200, 200, 429]);
  });

  it('/v1 and unprefixed URLs share one counter', async () => {
    for (let i = 0; i < 3; i++) await resetFrom('198.51.100.9', `p${i}@example.com`);
    for (let i = 0; i < 2; i++) await resetFrom('198.51.100.9', `q${i}@example.com`, '/v1');
    expect((await resetFrom('198.51.100.9', 'r@example.com', '/v1')).statusCode).toBe(429);
    expect((await resetFrom('198.51.100.9', 's@example.com')).statusCode).toBe(429);
  });

  it('the resend-confirmation and token-confirm routes are limited too', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/auth/email-confirmation/request', headers: { 'cf-connecting-ip': '198.51.100.20' }, payload: { email: `c${i}@example.com` } });
      expect(r.statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url: '/auth/email-confirmation/request', headers: { 'cf-connecting-ip': '198.51.100.20' }, payload: { email: 'c9@example.com' } })).statusCode).toBe(429);

    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await app.inject({ method: 'POST', url: '/auth/password-reset/confirm', headers: { 'cf-connecting-ip': '198.51.100.21' }, payload: { token: 'nope', password: 'Str0ng!Pass1' } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it('is off in the test suite by default (so other tests are not throttled)', async () => {
    setRouteLimitsEnabledForTests(false);
    for (let i = 0; i < 8; i++) expect((await resetFrom('198.51.100.30', `t${i}@example.com`)).statusCode).toBe(200);
  });
});

describe('account limits once a caller is signed in', () => {
  it('the eleventh key in an hour is refused for that account only', async () => {
    const alice = seedUser();
    const bob = seedUser();
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: alice.headers, payload: { label: `k${i}`, services: ['desk_api'] } });
      expect(r.statusCode, `key ${i}`).toBe(201);
    }
    const eleventh = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: alice.headers, payload: { label: 'k11', services: ['desk_api'] } });
    expect(eleventh.statusCode).toBe(429);
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(eleventh.body).detail).toMatch(/API keys created/);
    expect((await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bob.headers, payload: { label: 'b', services: ['desk_api'] } })).statusCode).toBe(201);
  });

  it('routes without a rule are untouched (listing keys, drafts)', async () => {
    const u = seedUser();
    for (let i = 0; i < 15; i++) expect((await app.inject({ method: 'GET', url: '/gateway/api-keys', headers: u.headers })).statusCode).toBe(200);
  });

  it('draft creation is limited to 30 an hour, per account', async () => {
    const u = seedUser();
    let refused = 0;
    for (let i = 0; i < 32; i++) {
      const r = await app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} });
      if (r.statusCode === 429) refused++;
    }
    expect(refused).toBeGreaterThanOrEqual(2);
  });
});

describe('the counter itself', () => {
  const limit: Limit = { name: 'unit', max: 2, windowMs: 1000, what: 'things' };

  it('allows up to max, refuses after with the seconds left, and starts over when the window ends', async () => {
    const t = 1_000_000;
    expect(await hit(limit, 'a', t)).toBe(0);
    expect(await hit(limit, 'a', t + 10)).toBe(0);
    expect(await hit(limit, 'a', t + 20)).toBe(1);
    expect(await hit(limit, 'b', t + 20)).toBe(0);
    expect(await hit(limit, 'a', t + 1500)).toBe(0);
  });

  it('shares its count through Redis when there is one, and still counts if Redis errors', async () => {
    const store = new Map<string, number>();
    fakeRedis = {
      incr: async (k: string) => { store.set(k, (store.get(k) ?? 0) + 1); return store.get(k)!; },
      pexpire: async () => 1,
      pttl: async () => 4500,
    };
    expect(await hit(limit, 'r')).toBe(0);
    expect(await hit(limit, 'r')).toBe(0);
    expect(await hit(limit, 'r')).toBe(5);
    expect([...store.keys()]).toEqual(['rlr:unit:r']);

    fakeRedis = { incr: async () => { throw new Error('down'); }, pexpire: async () => 1, pttl: async () => 1 };
    expect(await hit(limit, 'm')).toBe(0);
    expect(await hit(limit, 'm')).toBe(0);
    expect(await hit(limit, 'm')).toBeGreaterThan(0);
  });
});

describe('details the mutation check found untested', () => {
  it('a request with no e-mail address in its body is not counted against any e-mail limit', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/password-reset/request', headers: { 'cf-connecting-ip': '198.51.100.77' }, payload: {} });
      expect(res.statusCode).toBe(400); // refused for the missing address, never 429 from a shared "no address" counter
    }
  });

  it('the per-account limit ignores a caller nobody has signed in, and does nothing when limits are off', async () => {
    const { enforceUserRouteLimit } = await import('../../middleware/route-limits');
    const request = { method: 'POST', routeOptions: { url: '/gateway/api-keys' }, currentUser: undefined } as never;
    await expect(enforceUserRouteLimit(request, {} as never)).resolves.toBeUndefined();
    setRouteLimitsEnabledForTests(false);
    const signedIn = { method: 'POST', routeOptions: { url: '/gateway/api-keys' }, currentUser: { id: 'u-off' } } as never;
    for (let i = 0; i < 40; i++) await expect(enforceUserRouteLimit(signedIn, {} as never)).resolves.toBeUndefined();
  });

  it('the shared counter is given its lifetime on the first hit only, not refreshed by later ones', async () => {
    const calls: string[] = [];
    let count = 0;
    fakeRedis = { incr: async () => ++count, pexpire: async () => { calls.push('pexpire'); }, pttl: async () => 1500 };
    const limit: Limit = { name: 'ttl-check', max: 1, windowMs: 60_000, what: 'things' };
    expect(await hit(limit, 'subject')).toBe(0);
    expect(calls).toEqual(['pexpire']);
    expect(await hit(limit, 'subject')).toBe(2); // over the limit: told to wait ceil(1500 ms) = 2 s
    expect(calls).toEqual(['pexpire']); // not extended again
  });
});
