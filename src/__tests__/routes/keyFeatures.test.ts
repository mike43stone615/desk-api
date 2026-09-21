// Round 3 (September 2026): read-only keys, adding and removing an API on a key, /v1 create conventions,
// one set of rate-limit numbers, and cached reference lookups.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { resetUpstreamState } from '../../domain/upstream/client';
import { clearReferenceCache } from '../../routes/gatewayProxy';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;

let app: FastifyInstance;
const realFetch = globalThis.fetch;
const savedConfig = { ...config };

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
let fetchCalls: FetchCall[] = [];
let backendKeyCounter = 0;
let failMarketProvisioning = false;
let upstreamProxyStatus = 200;
let upstreamProxyOverride: (() => Response) | null = null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const headers = Object.fromEntries(
    Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  fetchCalls.push({ url, method, headers, body: init?.body as string | undefined });

  if (method === 'POST' && url.endsWith('/admin/api-keys')) {
    const isMarket = url.startsWith('http://market.test');
    if (isMarket && failMarketProvisioning) return json({ error: 'boom' }, 500);
    backendKeyCounter += 1;
    return json(
      {
        apiKey: {
          id: `${isMarket ? 'mkt' : 'reg'}-backend-${backendKeyCounter}`,
          key: `${isMarket ? 'mvapi_' : 'regapi_'}secret${backendKeyCounter}`,
        },
      },
      201,
    );
  }
  if (method === 'DELETE' && url.includes('/admin/api-keys/')) return new Response(null, { status: 204 });
  if (url.startsWith('http://registry.test/') || url.startsWith('http://market.test/')) {
    if (upstreamProxyOverride) return upstreamProxyOverride();
    return json({ ok: true, from: 'upstream' }, upstreamProxyStatus);
  }
  return json({ error: 'unexpected fetch in test' }, 500);
});

let userCounter = 0;
function seedUser(email: string, opts: { confirmed?: boolean } = {}) {
  userCounter += 1;
  const id = `user-${userCounter}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, {
    id,
    email,
    password_hash: 'x',
    first_name: 'Test',
    last_name: 'User',
    email_confirmed_at: opts.confirmed === false ? null : now,
    created_at: now,
    updated_at: now,
  });
  const token = `session-token-${id}`;
  fakeDb.seedSession(token, {
    id: `session-${id}`,
    user_id: id,
    token,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: now,
  });
  return { id, headers: { authorization: `Bearer ${token}` } };
}

async function createKey(
  user: { headers: Record<string, string> },
  services: string[],
  label = 'test key',
) {
  return app.inject({ method: 'POST', url: '/gateway/api-keys', headers: user.headers, payload: { label, services } });
}

beforeAll(async () => {
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
  config.registryApiUrl = 'http://registry.test';
  config.registryApiAdminKey = 'reg-admin-secret';
  config.marketApiUrl = 'http://market.test';
  config.marketApiAdminKey = 'mkt-admin-secret';
  vi.stubGlobal('fetch', fetchMock);
  app = await buildApp();
});

afterAll(() => {
  Object.assign(config, savedConfig);
  vi.stubGlobal('fetch', realFetch);
});

beforeEach(() => {
  resetUpstreamState();
  fetchCalls = [];
  failMarketProvisioning = false;
  upstreamProxyStatus = 200;
  upstreamProxyOverride = null;
  fakeDb.idempotencyKeys.clear();
  fakeDb.gatewayKeys.clear();
  fakeDb.gatewayGrants.length = 0;
});


describe('scoped keys', () => {
  it('a key limited to "drafts" can read drafts and is refused the rest of the Desk API', async () => {
    const user = seedUser('scoped@example.com');
    const created = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: user.headers, payload: { label: 'drafts only', services: ['desk_api'], deskScopes: ['drafts'] } });
    expect(created.statusCode).toBe(201);
    const { apiKey } = JSON.parse(created.body);
    expect(apiKey.deskScopes).toEqual(['drafts']);
    const key = apiKey.key as string;
    expect((await app.inject({ method: 'GET', url: '/setup/drafts', headers: { 'x-api-key': key } })).statusCode).toBe(200);
    const other = await app.inject({ method: 'GET', url: '/setup/businesses', headers: { 'x-api-key': key } });
    expect(other.statusCode).toBe(403);
    expect(JSON.parse(other.body).code).toBe('api_key_scope_missing');
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': key } })).statusCode).toBe(403);
  });

  it('a key without a choice has every scope, and an unknown scope is refused at creation', async () => {
    const user = seedUser('allscopes@example.com');
    const created = JSON.parse((await createKey(user, ['desk_api'])).body).apiKey;
    expect(created.deskScopes).toEqual(['profile', 'drafts', 'businesses']);
    expect((await app.inject({ method: 'GET', url: '/setup/businesses', headers: { 'x-api-key': created.key } })).statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: user.headers, payload: { label: 'x', services: ['desk_api'], deskScopes: ['everything'] } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('adding and removing an API on an existing key', () => {
  it('adds a brokered API (a new backend key is minted), keeps the key secret unchanged, and removes it again', async () => {
    const user = seedUser('grants@example.com');
    const created = JSON.parse((await createKey(user, ['desk_api'])).body).apiKey;
    const before = fetchCalls.length;
    const added = await app.inject({ method: 'POST', url: `/gateway/api-keys/${created.id}/services`, headers: user.headers, payload: { service: 'registry_api' } });
    expect(added.statusCode).toBe(200);
    expect(JSON.parse(added.body).apiKey.services).toEqual(['desk_api', 'registry_api']);
    expect(fetchCalls.slice(before).some((c) => c.method === 'POST' && c.url.endsWith('/admin/api-keys'))).toBe(true);
    const call = await app.inject({ method: 'GET', url: '/gateway/registry/business-structures', headers: { 'x-api-key': created.key } });
    expect(call.statusCode).toBe(200);
    const removed = await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${created.id}/services/registry_api`, headers: user.headers });
    expect(removed.statusCode).toBe(200);
    expect(JSON.parse(removed.body).apiKey.services).toEqual(['desk_api']);
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('/admin/api-keys/'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/gateway/registry/business-structures', headers: { 'x-api-key': created.key } })).statusCode).toBe(403);
  });

  it('the last API cannot be removed, someone elses key is not found, and a key cannot change its own APIs', async () => {
    const user = seedUser('own@example.com');
    const other = seedUser('other@example.com');
    const created = JSON.parse((await createKey(user, ['desk_api'])).body).apiKey;
    expect((await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${created.id}/services/desk_api`, headers: user.headers })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/gateway/api-keys/${created.id}/services`, headers: other.headers, payload: { service: 'registry_api' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/gateway/api-keys/${created.id}/services`, headers: { 'x-api-key': created.key }, payload: { service: 'registry_api' } })).statusCode).toBe(403);
  });
});

describe('v1 create conventions', () => {
  it('a create under /v1 answers 201 with a Location header', async () => {
    const user = seedUser('loc@example.com');
    const created = await app.inject({ method: 'POST', url: '/v1/setup/drafts', headers: user.headers, payload: {} });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/v1/setup/drafts/${JSON.parse(created.body).id}`);
    const key = await app.inject({ method: 'POST', url: '/v1/gateway/api-keys', headers: user.headers, payload: { label: 'k', services: ['desk_api'] } });
    expect(key.statusCode).toBe(201);
    expect(key.headers.location).toBe('/v1/gateway/api-keys');
  });
});

describe('the same rate-limit numbers on every route', () => {
  it('a proxied call reports whichever of the two limits is closer to running out', async () => {
    const user = seedUser('limits@example.com');
    const created = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey;
    upstreamProxyOverride = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1789000000' } });
    const res = await app.inject({ method: 'GET', url: '/gateway/registry/business-structures', headers: { 'x-api-key': created.key } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-remaining']).toBe('3');
    expect(res.headers['x-ratelimit-limit']).toBe('60');
  });
});

describe('reference lookups are kept for a while', () => {
  it('the second identical lookup is answered from memory (X-Cache: HIT) without calling the backend', async () => {
    process.env.REFERENCE_CACHE_IN_TESTS = '1';
    clearReferenceCache();
    try {
      const user = seedUser('cache@example.com');
      const created = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey;
      const first = await app.inject({ method: 'GET', url: '/gateway/registry/business-structures', headers: { 'x-api-key': created.key } });
      const calls = fetchCalls.length;
      const second = await app.inject({ method: 'GET', url: '/gateway/registry/business-structures', headers: { 'x-api-key': created.key } });
      expect(first.headers['x-cache']).toBe('MISS');
      expect(second.headers['x-cache']).toBe('HIT');
      expect(fetchCalls.length).toBe(calls);
      expect(second.body).toBe(first.body);
      expect((await app.inject({ method: 'GET', url: '/gateway/registry/business-structures', headers: { 'x-api-key': 'deskgw_nope' } })).statusCode).toBe(401);
    } finally {
      delete process.env.REFERENCE_CACHE_IN_TESTS;
      clearReferenceCache();
    }
  });
});
