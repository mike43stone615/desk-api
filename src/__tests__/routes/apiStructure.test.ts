// The shape of the API itself: how it answers URLs that don't exist, verbs that
// aren't allowed, what may be cached, who may call it from a browser, and how
// lists are paged. (Individual endpoints have their own test files.)
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { pool } from '../../db';
import { buildApp } from '../../app';
import { emailed } from '../helpers/email-capture';
import { config } from '../../config';
import { parsePage, slicePage } from '../../validators/pagination';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

function seedSession(email: string) {
  const id = `u-${email}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, {
    id, email, password_hash: 'x', first_name: 'A', last_name: 'B',
    email_confirmed_at: now, created_at: now, updated_at: now,
  });
  const token = `tok-${id}`;
  fakeDb.seedSession(token, {
    id: `s-${id}`, user_id: id, token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now,
  });
  return { authorization: `Bearer ${token}` };
}

describe('unknown URLs and wrong methods', () => {
  it('an unknown URL is a 404 in the standard error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'https://api.deskbusiness.co/errors/not_found', title: 'Not Found', status: 404, instance: '/nope' });
    expect(JSON.parse(res.body).error).toBe(JSON.parse(res.body).detail);
  });

  it('a known URL with the wrong method is a 405 that says what is allowed', async () => {
    const res = await app.inject({ method: 'PUT', url: '/setup/drafts', payload: {} });
    expect(res.statusCode).toBe(405);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    const allow = String(res.headers.allow).split(', ');
    expect(allow).toEqual(expect.arrayContaining(['GET', 'POST', 'OPTIONS']));
    expect(allow).not.toContain('PUT');
    expect(JSON.parse(res.body)).toMatchObject({ status: 405, title: 'Method Not Allowed' });
  });

  it('works the same for parameterised, versioned and wildcard routes', async () => {
    const draft = await app.inject({ method: 'POST', url: '/v1/setup/drafts/abc' });
    expect(draft.statusCode).toBe(405);
    expect(String(draft.headers.allow)).toContain('PATCH');

    const proxy = await app.inject({ method: 'PUT', url: '/v1/gateway/registry/business-structures' });
    expect(proxy.statusCode).toBe(405);
    expect(String(proxy.headers.allow)).toMatch(/GET.*POST/);

    const health = await app.inject({ method: 'DELETE', url: '/health' });
    expect(health.statusCode).toBe(405);
    expect(String(health.headers.allow)).toContain('HEAD');
  });

  it('a path that exists for no method at all stays a 404', async () => {
    for (const url of ['/setup/draftz', '/v1/nope', '/gateway/registry']) {
      const res = await app.inject({ method: 'PUT', url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('a trailing or doubled slash reaches the same handler instead of a 404 or an empty :id', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '//health' })).statusCode).toBe(200);
    // Not treated as GET /setup/drafts/:id with an empty id: with a session it lists drafts.
    const headers = seedSession('slash@example.com');
    const res = await app.inject({ method: 'GET', url: '/setup/drafts/', headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('drafts');
  });
});

describe('/v1 has the same operational routes, plus an index', () => {
  it('serves health, liveness, docs and metrics under /v1 exactly as without it', async () => {
    for (const path of ['/health', '/health/live', '/docs/openapi.json', '/docs', '/metrics']) {
      const plain = await app.inject({ method: 'GET', url: path });
      const versioned = await app.inject({ method: 'GET', url: `/v1${path}` });
      expect(versioned.statusCode, `/v1${path}`).toBe(plain.statusCode);
      expect(versioned.statusCode, `/v1${path}`).not.toBe(404);
    }
  });

  it('the /v1 docs page loads the /v1 spec', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/docs' });
    if (res.statusCode === 200) expect(res.body).toContain("url: '/v1/docs/openapi.json'");
  });

  it('GET /v1 says where things are', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ service: 'desk-api', version: 'v1', health: '/v1/health', libraryDocs: '/v1/gateway/openapi.json' });
    expect((await app.inject({ method: 'GET', url: '/v1/' })).statusCode).toBe(200);
  });
});

describe('caching', () => {
  it('API answers, including errors, may not be stored', async () => {
    const ok = await app.inject({ method: 'GET', url: '/health' });
    expect(ok.headers['cache-control']).toBe('no-store');
    const unauthorized = await app.inject({ method: 'GET', url: '/auth/session' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  it('a new API key response is not storable', async () => {
    const headers = seedSession('nostore@example.com');
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    const res = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers, payload: { label: 'k', services: ['desk_api'] } });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the web pages keep their own revalidation rule', async () => {
    const page = await app.inject({ method: 'GET', url: '/login' });
    expect(page.headers['cache-control']).toBe('no-cache');
  });
});

describe('what a browser may send cross-site', () => {
  const origin = config.corsOrigins[0];

  it('may send the session-transport header, but never x-api-key; preflights are cacheable', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/auth/signin',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-session-transport' },
    });
    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
    expect(allowed).toContain('x-session-transport');
    expect(allowed).not.toContain('x-api-key');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('a foreign site gets no cross-site permission at all', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/gateway/registry/business-structures',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('sign-in answers', () => {
  const email = 'transport@example.com';
  const password = 'Str0ng!Pass';

  async function signUpConfirmed() {
    await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password, firstName: 'T', lastName: 'P' } });
    const token = emailed.confirm.get(email) as string;
    await app.inject({ method: 'POST', url: '/auth/email-confirmation/confirm', payload: { token } });
  }

  it('a wrong password is the standard error shape, not a bare {error}', async () => {
    await signUpConfirmed();
    const res = await app.inject({ method: 'POST', url: '/auth/signin', payload: { email, password: 'Wrong!Pass1' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(JSON.parse(res.body)).toMatchObject({ status: 401, title: 'Unauthorized', detail: 'Invalid email or password.', error: 'Invalid email or password.' });
  });

  it('native clients still get the token in the body', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signin', payload: { email, password } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).token).toBeTruthy();
  });

  it('a browser app that asks for cookie transport gets the cookie and no token in the body', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'x-session-transport': 'cookie' }, payload: { email, password } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toBeUndefined();
    expect(body.user.email).toBe(email);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);

    // The cookie alone is enough to be signed in.
    const value = /=([^;]+)/.exec(cookie)![1];
    const name = cookie.split('=')[0];
    const session = await app.inject({ method: 'GET', url: '/auth/session', cookies: { [name]: value } });
    expect(session.statusCode).toBe(200);
  });
});

describe('list paging', () => {
  it('rejects a limit or offset that makes no sense, in the standard error shape', async () => {
    const headers = seedSession('paging@example.com');
    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=x']) {
      for (const path of ['/setup/businesses', '/setup/invites']) {
        const res = await app.inject({ method: 'GET', url: `${path}?${query}`, headers });
        expect(res.statusCode, `${path}?${query}`).toBe(400);
        expect(res.headers['content-type']).toMatch(/problem\+json/);
      }
    }
  });

  it('parsePage defaults to the first 100 and caps at 200', () => {
    expect(parsePage({})).toEqual({ limit: 100, offset: 0 });
    expect(parsePage(undefined)).toEqual({ limit: 100, offset: 0 });
    expect(parsePage({ limit: '200', offset: '50' })).toEqual({ limit: 200, offset: 50 });
    expect(() => parsePage({ limit: '201' })).toThrow();
  });

  it('slicePage reports whether another page exists from one extra row', () => {
    expect(slicePage([1, 2, 3], { limit: 2, offset: 0 })).toEqual({ rows: [1, 2], hasMore: true });
    expect(slicePage([1, 2], { limit: 2, offset: 0 })).toEqual({ rows: [1, 2], hasMore: false });
    expect(slicePage([], { limit: 2, offset: 0 })).toEqual({ rows: [], hasMore: false });
  });
});
