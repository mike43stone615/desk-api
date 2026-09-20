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

describe('GET /gateway/services (the library listing)', () => {
  it('lists all three APIs, available when configured', async () => {
    const user = seedUser('lib@example.com');
    const res = await app.inject({ method: 'GET', url: '/gateway/services', headers: user.headers });
    expect(res.statusCode).toBe(200);
    const { services } = JSON.parse(res.body);
    expect(services.map((s: { service: string }) => s.service)).toEqual([
      'desk_api',
      'registry_api',
      'market_validation_api',
    ]);
    expect(services.every((s: { available: boolean }) => s.available)).toBe(true);
  });

  it('requires a signed-in session', async () => {
    const res = await app.inject({ method: 'GET', url: '/gateway/services' });
    expect(res.statusCode).toBe(401);
  });
});

describe('creating keys', () => {
  it('returns the plaintext exactly once and stores only its hash', async () => {
    const user = seedUser('create@example.com');
    const res = await createKey(user, ['desk_api']);
    expect(res.statusCode).toBe(201);
    const { apiKey } = JSON.parse(res.body);
    expect(apiKey.key).toMatch(/^deskgw_[0-9a-f]{48}$/);
    expect(apiKey.services).toEqual(['desk_api']);

    const stored = [...fakeDb.gatewayKeys.values()][0];
    expect(stored.key_hash).not.toBe(apiKey.key);
    expect(JSON.stringify([...fakeDb.gatewayKeys.values()])).not.toContain(apiKey.key);

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/gateway/api-keys', headers: user.headers })).body);
    expect(list.apiKeys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(apiKey.key);
    expect(list.apiKeys[0].key).toBeUndefined();
  });

  it('brokers real backend keys for registry/market grants and stores them encrypted', async () => {
    const user = seedUser('broker@example.com');
    const res = await createKey(user, ['desk_api', 'registry_api', 'market_validation_api']);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).apiKey.services).toEqual(['desk_api', 'registry_api', 'market_validation_api']);

    const provisionCalls = fetchCalls.filter((c) => c.method === 'POST');
    expect(provisionCalls.map((c) => c.url).sort()).toEqual([
      'http://market.test/admin/api-keys',
      'http://registry.test/admin/api-keys',
    ]);
    expect(provisionCalls.find((c) => c.url.startsWith('http://registry.test'))!.headers['x-api-key']).toBe('reg-admin-secret');
    expect(provisionCalls.find((c) => c.url.startsWith('http://market.test'))!.headers['x-api-key']).toBe('mkt-admin-secret');
    expect(provisionCalls[0].body).toContain(`gateway:${user.id}:`);

    const grants = fakeDb.gatewayGrants;
    expect(grants.map((g) => g.service).sort()).toEqual(['desk_api', 'market_validation_api', 'registry_api']);
    const deskGrant = grants.find((g) => g.service === 'desk_api')!;
    expect(deskGrant.encrypted_backend_key).toBeNull();
    for (const g of grants.filter((x) => x.service !== 'desk_api')) {
      expect(String(g.encrypted_backend_key).startsWith('v2:')).toBe(true);
      expect(String(g.encrypted_backend_key)).not.toContain('secret');
    }
  });

  it('rolls back cleanly when a later backend fails: nothing stored, earlier backend key revoked', async () => {
    const user = seedUser('rollback@example.com');
    failMarketProvisioning = true;
    const res = await createKey(user, ['registry_api', 'market_validation_api']);
    expect(res.statusCode).toBe(502);
    expect(fakeDb.gatewayKeys.size).toBe(0);
    expect(fakeDb.gatewayGrants).toHaveLength(0);
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.startsWith('http://registry.test/admin/api-keys/reg-backend-'))).toBe(true);
  });

  it('requires a session and a confirmed email', async () => {
    expect((await app.inject({ method: 'POST', url: '/gateway/api-keys', payload: { label: 'x', services: ['desk_api'] } })).statusCode).toBe(401);
    const unconfirmed = seedUser('unconfirmed@example.com', { confirmed: false });
    expect((await createKey(unconfirmed, ['desk_api'])).statusCode).toBe(403);
  });

  it('validates label and services', async () => {
    const user = seedUser('validate@example.com');
    expect((await createKey(user, [])).statusCode).toBe(400);
    expect((await createKey(user, ['not_a_service'])).statusCode).toBe(400);
    expect((await createKey(user, ['desk_api'], '   ')).statusCode).toBe(400);
    expect((await createKey(user, ['desk_api'], 'x'.repeat(65))).statusCode).toBe(400);
  });

  it('reports a service unavailable (503) when its broker prerequisites are missing', async () => {
    const user = seedUser('unavailable@example.com');
    const saved = config.marketApiAdminKey;
    config.marketApiAdminKey = undefined;
    try {
      const res = await createKey(user, ['market_validation_api']);
      expect(res.statusCode).toBe(503);
      expect(fakeDb.gatewayKeys.size).toBe(0);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      config.marketApiAdminKey = saved;
    }
  });

  it('caps active keys per account', async () => {
    const user = seedUser('cap@example.com');
    for (let i = 0; i < 10; i += 1) expect((await createKey(user, ['desk_api'], `k${i}`)).statusCode).toBe(201);
    expect((await createKey(user, ['desk_api'], 'one too many')).statusCode).toBe(409);
  });
});

describe('listing and revoking are scoped to the owner', () => {
  it("never shows or revokes another user's key", async () => {
    const alice = seedUser('alice@example.com');
    const bob = seedUser('bob@example.com');
    const aliceKey = JSON.parse((await createKey(alice, ['desk_api'])).body).apiKey;

    const bobList = JSON.parse((await app.inject({ method: 'GET', url: '/gateway/api-keys', headers: bob.headers })).body);
    expect(bobList.apiKeys).toEqual([]);

    const bobRevoke = await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${aliceKey.id}`, headers: bob.headers });
    expect(bobRevoke.statusCode).toBe(404);
    const aliceList = JSON.parse((await app.inject({ method: 'GET', url: '/gateway/api-keys', headers: alice.headers })).body);
    expect(aliceList.apiKeys).toHaveLength(1);
  });

  it('revoke stops the key, wipes stored backend secrets, and revokes the backend keys', async () => {
    const user = seedUser('revoke@example.com');
    const { apiKey } = JSON.parse((await createKey(user, ['desk_api', 'registry_api'])).body);
    fetchCalls = [];

    const res = await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${apiKey.id}`, headers: user.headers });
    expect(res.statusCode).toBe(204);
    expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(fakeDb.gatewayGrants.every((g) => g.encrypted_backend_key === null)).toBe(true);

    const after = await app.inject({ method: 'GET', url: '/setup/businesses', headers: { 'x-api-key': apiKey.key } });
    expect(after.statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${apiKey.id}`, headers: user.headers })).statusCode).toBe(409);
  });

  it('still revokes the gateway key if a backend is unreachable during revoke', async () => {
    const user = seedUser('revoke-down@example.com');
    const { apiKey } = JSON.parse((await createKey(user, ['registry_api'])).body);
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${apiKey.id}`, headers: user.headers });
    expect(res.statusCode).toBe(204);
    expect(fakeDb.gatewayKeys.get(apiKey.id)!.revoked_at).toBeTruthy();
  });
});

describe('a key on desk-api itself: only its owner\'s data, read-only, never admin', () => {
  it("returns only the owner's own drafts (and works under /v1)", async () => {
    const alice = seedUser('alice-data@example.com');
    const bob = seedUser('bob-data@example.com');
    await app.inject({ method: 'POST', url: '/setup/drafts', headers: alice.headers, payload: {} });
    await app.inject({ method: 'POST', url: '/setup/drafts', headers: bob.headers, payload: {} });
    await app.inject({ method: 'POST', url: '/setup/drafts', headers: bob.headers, payload: {} });

    const aliceKey = JSON.parse((await createKey(alice, ['desk_api'])).body).apiKey.key;
    const bobKey = JSON.parse((await createKey(bob, ['desk_api'])).body).apiKey.key;

    const a = await app.inject({ method: 'GET', url: '/setup/drafts', headers: { 'x-api-key': aliceKey } });
    expect(a.statusCode).toBe(200);
    expect(JSON.parse(a.body).drafts).toHaveLength(1);
    const b = await app.inject({ method: 'GET', url: '/v1/setup/drafts', headers: { 'x-api-key': bobKey } });
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(b.body).drafts).toHaveLength(2);

    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': aliceKey } });
    expect(JSON.parse(session.body).user.email).toBe('alice-data@example.com');
  });

  it('cannot reach a draft by id that belongs to someone else', async () => {
    const alice = seedUser('alice-id@example.com');
    const bob = seedUser('bob-id@example.com');
    const bobDraftId = JSON.parse((await app.inject({ method: 'POST', url: '/setup/drafts', headers: bob.headers, payload: {} })).body).id;
    const aliceKey = JSON.parse((await createKey(alice, ['desk_api'])).body).apiKey.key;

    const res = await app.inject({ method: 'GET', url: `/setup/drafts/${bobDraftId}`, headers: { 'x-api-key': aliceKey } });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ['POST', '/setup/drafts'],
    ['PATCH', '/setup/drafts/abc'],
    ['DELETE', '/setup/drafts/abc'],
    ['POST', '/setup/drafts/abc/complete'],
    ['POST', '/setup/businesses/abc/members'],
    ['DELETE', '/setup/businesses/abc/members/xyz'],
    ['POST', '/setup/invites/abc/accept'],
    ['POST', '/auth/password'],
    ['POST', '/gateway/api-keys'],
    ['GET', '/gateway/api-keys'],
    ['GET', '/gateway/services'],
    ['DELETE', '/gateway/api-keys/abc'],
  ])('refuses %s %s for a key (403) even though a session may call it', async (method, url) => {
    const user = seedUser(`deny-${method}-${url}@example.com`);
    const key = JSON.parse((await createKey(user, ['desk_api'])).body).apiKey.key;
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { 'x-api-key': key },
      payload: method === 'GET' || method === 'DELETE' ? undefined : { label: 'x', services: ['desk_api'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('can never reach /admin, even when the key belongs to an admin account', async () => {
    const admin = seedUser('admin@example.com'); // in ADMIN_EMAILS via __tests__/setup.ts
    const key = JSON.parse((await createKey(admin, ['desk_api'])).body).apiKey.key;

    const asSession = await app.inject({ method: 'GET', url: '/admin/tables', headers: admin.headers });
    expect(asSession.statusCode).toBe(200); // sanity: the same account IS admin by session

    for (const [method, url] of [
      ['GET', '/admin/tables'],
      ['GET', '/admin/tables/users/rows'],
      ['PATCH', '/admin/tables/users/rows/x'],
      ['DELETE', '/admin/tables/users/rows/x'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { 'x-api-key': key }, payload: method === 'PATCH' ? { values: {} } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('rejects a revoked key, an unknown key, and a malformed key', async () => {
    const user = seedUser('bad-keys@example.com');
    const { apiKey } = JSON.parse((await createKey(user, ['desk_api'])).body);
    await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${apiKey.id}`, headers: user.headers });
    for (const key of [apiKey.key, `deskgw_${'0'.repeat(48)}`, 'deskgw_short']) {
      const res = await app.inject({ method: 'GET', url: '/setup/drafts', headers: { 'x-api-key': key } });
      expect(res.statusCode).toBe(401);
    }
  });

  it('a key without the desk_api grant cannot call desk-api routes (403)', async () => {
    const user = seedUser('registry-only@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    const res = await app.inject({ method: 'GET', url: '/setup/drafts', headers: { 'x-api-key': key } });
    expect(res.statusCode).toBe(403);
  });

  it("a session still wins: a bogus x-api-key doesn't disturb normal session auth", async () => {
    const user = seedUser('session-wins@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/setup/drafts',
      headers: { ...user.headers, 'x-api-key': 'deskgw_ignored' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('proxying to registry-api and market-validation-api', () => {
  const NAME_CHECK = '/gateway/registry/functions/v1/check-business-name-availability';

  it("forwards with the grant's own backend key — never the developer's key", async () => {
    const user = seedUser('proxy@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    fetchCalls = [];

    const res = await app.inject({
      method: 'POST',
      url: `/v1${NAME_CHECK}`,
      headers: { 'x-api-key': key },
      payload: { businessName: 'Acme', stateOfFormation: 'FL' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, from: 'upstream' });

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe('http://registry.test/functions/v1/check-business-name-availability');
    expect(call.headers['x-api-key']).toMatch(/^regapi_secret\d+$/);
    expect(JSON.stringify(call)).not.toContain(key);
    expect(JSON.parse(call.body!)).toEqual({ businessName: 'Acme', stateOfFormation: 'FL' });
  });

  it('proxies the market API and passes upstream rate-limit headers through', async () => {
    const user = seedUser('market@example.com');
    const key = JSON.parse((await createKey(user, ['market_validation_api'])).body).apiKey.key;
    const res = await app.inject({
      method: 'POST',
      url: '/gateway/market/research/analyze',
      headers: { 'x-api-key': key },
      payload: { businessIdea: 'coffee cart' },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchCalls.at(-1)!.url).toBe('http://market.test/research/analyze');
    expect(fetchCalls.at(-1)!.headers['x-api-key']).toMatch(/^mvapi_secret\d+$/);
  });

  it('forwards the query string only for endpoints that take one', async () => {
    const user = seedUser('query@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    await app.inject({ method: 'GET', url: '/gateway/registry/business-structures?state=FL', headers: { 'x-api-key': key } });
    expect(fetchCalls.at(-1)!.url).toBe('http://registry.test/business-structures?state=FL');
    await app.inject({ method: 'GET', url: '/gateway/registry/business-structures/llc', headers: { 'x-api-key': key } });
    expect(fetchCalls.at(-1)!.url).toBe('http://registry.test/business-structures/llc');
  });

  it('requires a key with the right grant', async () => {
    const user = seedUser('grants@example.com');
    const deskOnly = JSON.parse((await createKey(user, ['desk_api'])).body).apiKey.key;
    const registryOnly = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    fetchCalls = [];

    expect((await app.inject({ method: 'POST', url: NAME_CHECK, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: NAME_CHECK, headers: { 'x-api-key': 'nope' }, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: NAME_CHECK, headers: { 'x-api-key': deskOnly }, payload: {} })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/gateway/market/research/analyze', headers: { 'x-api-key': registryOnly }, payload: {} })).statusCode,
    ).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it('reaches every endpoint each backend gates behind a key (name trend, scoring methodology included)', async () => {
    const user = seedUser('coverage@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api', 'market_validation_api'])).body).apiKey.key;
    const cases: Array<['GET' | 'POST', string, string]> = [
      ['POST', '/gateway/registry/functions/v1/check-name-trend', 'http://registry.test/functions/v1/check-name-trend'],
      ['POST', '/gateway/registry/name-trend', 'http://registry.test/functions/v1/check-name-trend'],
      ['GET', '/gateway/market/scoring-methodology', 'http://market.test/scoring-methodology'],
    ];
    for (const [method, url, upstream] of cases) {
      fetchCalls = [];
      const res = await app.inject({ method, url, headers: { 'x-api-key': key }, payload: method === 'POST' ? { businessName: 'Acme' } : undefined });
      expect(res.statusCode, url).toBe(200);
      expect(fetchCalls[0].url, url).toBe(upstream);
    }
  });

  it('documents every proxied endpoint in the OpenAPI spec', async () => {
    const { OPENAPI_SPEC } = await import('../../openapi');
    const paths = (OPENAPI_SPEC as { paths: Record<string, Record<string, unknown>> }).paths;
    const documented: Array<['get' | 'post', string]> = [
      ['post', '/gateway/registry/name-availability'], ['post', '/gateway/registry/dba-availability'],
      ['post', '/gateway/registry/trademark-availability'], ['post', '/gateway/registry/multi-state-availability'],
      ['post', '/gateway/registry/batch-availability'], ['post', '/gateway/registry/name-trend'],
      ['get', '/gateway/registry/sync-status'], ['get', '/gateway/registry/business-structures'],
      ['get', '/gateway/registry/business-structures/{slug}'], ['post', '/gateway/registry/business-structures/recommend'],
      ['post', '/gateway/market/research/analyze'], ['get', '/gateway/market/scoring-methodology'],
    ];
    for (const [method, path] of documented) expect(paths[path]?.[method], `${method} ${path}`).toBeTruthy();

    // ...and every documented path really is served by the proxy (never a 404 "no such endpoint").
    const user = seedUser('docs-sync@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api', 'market_validation_api'])).body).apiKey.key;
    for (const [method, path] of documented) {
      const url = `/v1${path.replace('{slug}', 'llc')}`;
      const res = await app.inject({ method: method === 'get' ? 'GET' : 'POST', url, headers: { 'x-api-key': key }, payload: method === 'post' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).not.toBe(404);
    }
  });

  it('only reaches allowlisted upstream endpoints — no admin, no traversal', async () => {
    const user = seedUser('escape@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api', 'market_validation_api'])).body).apiKey.key;
    fetchCalls = [];

    const attempts: Array<['GET' | 'POST', string]> = [
      ['GET', '/gateway/registry/admin/api-keys'],
      ['POST', '/gateway/registry/admin/api-keys'],
      ['GET', '/gateway/registry/admin/tables'],
      ['GET', '/gateway/registry/business-structures/..%2Fadmin%2Fapi-keys'],
      ['GET', '/gateway/registry/business-structures/../admin/api-keys'],
      ['GET', '/gateway/registry/business-structures/recommend'],
      ['GET', '/gateway/registry/functions/v1/check-business-name-availability'],
      ['POST', '/gateway/registry/health'],
      ['GET', '/gateway/market/admin/api-keys'],
      ['POST', '/gateway/market/admin/api-keys'],
      ['GET', '/gateway/market/research/analyze'],
    ];
    for (const [method, url] of attempts) {
      const res = await app.inject({ method, url, headers: { 'x-api-key': key }, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it('turns an upstream credential rejection into a 502 that does not look like the developer\'s key failing', async () => {
    const user = seedUser('upstream403@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    upstreamProxyStatus = 403;
    const res = await app.inject({ method: 'POST', url: NAME_CHECK, headers: { 'x-api-key': key }, payload: {} });
    expect(res.statusCode).toBe(502);
  });

  it('passes through upstream non-credential errors (e.g. 400, 429) as-is', async () => {
    const user = seedUser('upstream429@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    upstreamProxyStatus = 429;
    const res = await app.inject({ method: 'POST', url: NAME_CHECK, headers: { 'x-api-key': key }, payload: {} });
    expect(res.statusCode).toBe(429);
  });

  it('stops working the moment the key is revoked', async () => {
    const user = seedUser('proxy-revoke@example.com');
    const { apiKey } = JSON.parse((await createKey(user, ['registry_api'])).body);
    expect((await app.inject({ method: 'POST', url: NAME_CHECK, headers: { 'x-api-key': apiKey.key }, payload: {} })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${apiKey.id}`, headers: user.headers });
    expect((await app.inject({ method: 'POST', url: NAME_CHECK, headers: { 'x-api-key': apiKey.key }, payload: {} })).statusCode).toBe(401);
  });
});

describe('errors from the backends look like every other error', () => {
  async function callWith(override: () => Response) {
    const user = seedUser(`err-${Math.random()}@example.com`);
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    upstreamProxyOverride = override;
    return app.inject({
      method: 'POST',
      url: '/v1/gateway/registry/name-availability',
      headers: { 'x-api-key': key },
      payload: { businessName: 'Acme' },
    });
  }

  it("turns a backend's own error body into the standard problem shape, keeping the status", async () => {
    const res = await callWith(() => json({ responseId: 'r1', servedAt: 'now', error: 'stateOfFormation is required' }, 400));
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ status: 400, title: 'Bad Request', detail: 'stateOfFormation is required', error: 'stateOfFormation is required' });
    expect(body.instance).toBe('/v1/gateway/registry/name-availability');
  });

  it('keeps a backend validation list and reads the message from other field names', async () => {
    const res = await callWith(() => json({ message: 'Invalid request.', errors: [{ path: ['names'], message: 'too many' }] }, 400));
    const body = JSON.parse(res.body);
    expect(body.detail).toBe('Invalid request.');
    expect(body.errors).toEqual([{ path: ['names'], message: 'too many' }]);
  });

  it('keeps Retry-After on a rate limit and copes with a non-JSON failure body', async () => {
    const limited = await callWith(
      () => new Response(JSON.stringify({ error: 'Rate limit exceeded (per-minute).' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '42' } }),
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('42');
    expect(JSON.parse(limited.body).detail).toBe('Rate limit exceeded (per-minute).');

    const html = await callWith(() => new Response('<html>oops</html>', { status: 504, statusText: 'Gateway Timeout' }));
    expect(html.statusCode).toBe(504);
    expect(html.headers['content-type']).toMatch(/problem\+json/);
    expect(JSON.parse(html.body).title).toBe('Error');
  });

  it('leaves a successful answer exactly as the backend sent it', async () => {
    const res = await callWith(() => json({ available: true }, 200));
    expect(JSON.parse(res.body)).toEqual({ available: true });
  });

  it('forwards the request id, so one id follows the call into the backend logs', async () => {
    const res = await callWith(() => json({ ok: true }));
    const forwarded = fetchCalls.at(-1)!;
    expect(forwarded.headers['x-request-id']).toBeTruthy();
    expect(forwarded.headers['x-request-id']).toBe(res.headers['x-request-id']);
  });
});

describe('clean public endpoint names', () => {
  it.each([
    ['POST', '/name-availability', '/functions/v1/check-business-name-availability'],
    ['POST', '/dba-availability', '/functions/v1/check-dba-name-availability'],
    ['POST', '/trademark-availability', '/functions/v1/check-trademark-availability'],
    ['POST', '/multi-state-availability', '/functions/v1/check-name-multi-state'],
    ['POST', '/batch-availability', '/functions/v1/check-names-batch'],
    ['POST', '/name-trend', '/functions/v1/check-name-trend'],
    ['GET', '/sync-status', '/functions/v1/registry-sync-status'],
  ])('%s %s reaches %s, and the old path still does too', async (method, publicPath, upstreamPath) => {
    const user = seedUser(`names-${Math.random()}@example.com`);
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    for (const path of [publicPath, upstreamPath]) {
      fetchCalls = [];
      const res = await app.inject({
        method: method as 'GET' | 'POST',
        url: `/v1/gateway/registry${path}`,
        headers: { 'x-api-key': key },
        payload: method === 'POST' ? { businessName: 'Acme' } : undefined,
      });
      expect(res.statusCode, path).toBe(200);
      expect(fetchCalls[0].url, path).toBe(`http://registry.test${upstreamPath}`);
    }
  });
});

describe('creating a key twice by accident (Idempotency-Key)', () => {
  const create = (user: { headers: Record<string, string> }, idem: string, payload: Record<string, unknown> = { label: 'one', services: ['desk_api'] }) =>
    app.inject({ method: 'POST', url: '/gateway/api-keys', headers: { ...user.headers, 'idempotency-key': idem }, payload });

  it('a retry with the same Idempotency-Key does not create a second key, and never replays the secret', async () => {
    const user = seedUser('idem@example.com');
    const first = await create(user, 'attempt-1');
    expect(first.statusCode).toBe(201);
    const secret = JSON.parse(first.body).apiKey.key as string;

    const retry = await create(user, 'attempt-1');
    expect(retry.statusCode).toBe(409);
    expect(JSON.parse(retry.body).detail).toMatch(/already created.*only once/i);
    expect(retry.body).not.toContain(secret);
    expect(fakeDb.gatewayKeys.size).toBe(1);

    // The secret is not kept in the idempotency table either.
    expect(JSON.stringify([...fakeDb.idempotencyKeys.values()])).not.toContain(secret);
  });

  it('a failed attempt does not use up the key: the corrected retry goes through', async () => {
    const user = seedUser('idem-fail@example.com');
    const bad = await create(user, 'attempt-2', { label: '', services: [] });
    expect(bad.statusCode).toBe(400);
    const good = await create(user, 'attempt-2', { label: 'fixed', services: ['desk_api'] });
    expect(good.statusCode).toBe(201);
  });

  it('without the header nothing changes: two requests make two keys', async () => {
    const user = seedUser('idem-none@example.com');
    expect((await createKey(user, ['desk_api'])).statusCode).toBe(201);
    expect((await createKey(user, ['desk_api'])).statusCode).toBe(201);
    expect(fakeDb.gatewayKeys.size).toBe(2);
  });
});

describe('the public API description', () => {
  it('needs no key or sign-in, and lists only what developers can use', async () => {
    for (const url of ['/gateway/openapi.json', '/v1/gateway/openapi.json']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      const spec = JSON.parse(res.body);
      const paths = Object.keys(spec.paths);
      expect(paths).toContain('/gateway/registry/name-availability');
      expect(paths).toContain('/gateway/api-keys');
      expect(paths).toContain('/setup/businesses');
      // The one /auth route a key may call is GET /auth/session; nothing else under /auth, and no admin or wizard routes.
      expect(paths.filter((p) => p.startsWith('/admin') || (p.startsWith('/auth') && p !== '/auth/session') || p.startsWith('/functions') || p.startsWith('/integrations'))).toEqual([]);
      expect(Object.keys(spec.paths['/auth/session'])).toEqual(['get']);
      expect(spec.components.securitySchemes.ApiLibraryKey).toBeTruthy();
      // Only the operations a key can call are kept on the Desk API paths.
      expect(Object.keys(spec.paths['/setup/drafts'])).toEqual(['get']);
    }
  });
});

describe('deleting a user does not leave their backend keys alive', () => {
  const adminHeaders = { 'x-api-key': 'test-admin-key' };
  let savedAdminKey: string | undefined;
  beforeAll(() => {
    savedAdminKey = config.adminApiKey;
    config.adminApiKey = 'test-admin-key';
  });
  afterAll(() => {
    config.adminApiKey = savedAdminKey;
  });

  const deleteUser = (id: string) => app.inject({ method: 'DELETE', url: `/admin/tables/desk.users/rows/${id}`, headers: adminHeaders });

  it('revokes the gateway key and both backend keys, then deletes the user', async () => {
    const user = seedUser('gone@example.com');
    const { apiKey } = JSON.parse((await createKey(user, ['desk_api', 'registry_api', 'market_validation_api'])).body);
    fetchCalls = [];

    const res = await deleteUser(user.id);
    expect(res.statusCode).toBe(200);
    const revoked = fetchCalls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(revoked).toHaveLength(2);
    expect(revoked.some((u) => u.startsWith('http://registry.test/admin/api-keys/reg-backend-'))).toBe(true);
    expect(revoked.some((u) => u.startsWith('http://market.test/admin/api-keys/mkt-backend-'))).toBe(true);
    expect(fakeDb.users.has(user.id)).toBe(false);
    expect(fakeDb.gatewayKeys.has(apiKey.id)).toBe(false);
    expect(fakeDb.backendRevocations.size).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/setup/businesses', headers: { 'x-api-key': apiKey.key } })).statusCode).toBe(401);
  });

  it('when a backend is down at that moment, the backend key is queued and revoked by the sweeper later', async () => {
    const user = seedUser('gone-down@example.com');
    await createKey(user, ['registry_api']);
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });

    expect((await deleteUser(user.id)).statusCode).toBe(200);
    expect(fakeDb.users.has(user.id)).toBe(false);
    expect(fakeDb.backendRevocations.size).toBe(1);

    fetchCalls = [];
    const { sweepBackendKeys } = await import('../../domain/gateway/orphans');
    expect(await sweepBackendKeys()).toEqual({ revoked: 1, failed: 0 });
    expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(fakeDb.backendRevocations.size).toBe(0);
  });

  it('a sweep that cannot reach the backend keeps the entry and counts the attempt', async () => {
    const user = seedUser('gone-down2@example.com');
    await createKey(user, ['market_validation_api']);
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    await deleteUser(user.id);
    expect(fakeDb.backendRevocations.size).toBe(1);

    const { sweepBackendKeys } = await import('../../domain/gateway/orphans');
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await sweepBackendKeys()).toEqual({ revoked: 0, failed: 1 });
    expect([...fakeDb.backendRevocations.values()][0].attempts).toBe(1);
    expect(await sweepBackendKeys()).toEqual({ revoked: 1, failed: 0 });
    expect(fakeDb.backendRevocations.size).toBe(0);
  });

  it('the sweeper also finishes a manual revoke whose backend was down', async () => {
    const user = seedUser('revoke-retry@example.com');
    const { apiKey } = JSON.parse((await createKey(user, ['registry_api'])).body);
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${apiKey.id}`, headers: user.headers })).statusCode).toBe(204);
    expect(fakeDb.gatewayGrants.find((g) => g.api_key_id === apiKey.id)!.backend_key_id).toBeTruthy();

    const { sweepBackendKeys } = await import('../../domain/gateway/orphans');
    expect(await sweepBackendKeys()).toEqual({ revoked: 1, failed: 0 });
    expect(fakeDb.gatewayGrants.find((g) => g.api_key_id === apiKey.id)!.backend_key_id).toBeNull();
    expect(await sweepBackendKeys()).toEqual({ revoked: 0, failed: 0 });
  });

  it('a normal revoke leaves nothing for the sweeper', async () => {
    const user = seedUser('revoke-clean@example.com');
    const { apiKey } = JSON.parse((await createKey(user, ['registry_api', 'market_validation_api'])).body);
    await app.inject({ method: 'DELETE', url: `/gateway/api-keys/${apiKey.id}`, headers: user.headers });
    const { sweepBackendKeys } = await import('../../domain/gateway/orphans');
    expect(await sweepBackendKeys()).toEqual({ revoked: 0, failed: 0 });
  });
});

describe('rotating GATEWAY_KEY_ENCRYPTION_SECRET', () => {
  const OLD = 'ab'.repeat(32);
  const NEW = '12'.repeat(32);
  const use = async (key: string) =>
    app.inject({ method: 'GET', url: '/gateway/registry/business-structures?state=FL', headers: { 'x-api-key': key } });

  it('a key made under the old secret keeps working while both are configured, and keys made after use the new one', async () => {
    const user = seedUser('rotate@example.com');
    config.gatewayKeyEncryptionSecret = OLD;
    const oldKey = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    expect((await use(oldKey)).statusCode).toBe(200);

    config.gatewayKeyEncryptionSecret = NEW;
    config.gatewayKeyEncryptionSecretsPrevious = [OLD];
    try {
      expect((await use(oldKey)).statusCode).toBe(200);
      const newKey = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
      expect((await use(newKey)).statusCode).toBe(200);
      const stored = fakeDb.gatewayGrants.filter((g) => g.service === 'registry_api').map((g) => String(g.encrypted_backend_key));
      expect(new Set(stored.map((s) => s.split(':')[1])).size).toBe(2); // two different key ids in use
    } finally {
      config.gatewayKeyEncryptionSecretsPrevious = [];
    }
  });

  it('once the old secret is dropped without re-encrypting, the old key stops working cleanly (not a crash)', async () => {
    const user = seedUser('rotate-drop@example.com');
    config.gatewayKeyEncryptionSecret = OLD;
    const oldKey = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    config.gatewayKeyEncryptionSecret = NEW;
    config.gatewayKeyEncryptionSecretsPrevious = [];
    fetchCalls = [];
    const res = await use(oldKey);
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(fetchCalls).toHaveLength(0);
    config.gatewayKeyEncryptionSecret = OLD;
  });
});

describe('a struggling backend cannot hurt the gateway', () => {
  const lookup = (key: string) =>
    app.inject({ method: 'GET', url: '/gateway/registry/business-structures?state=FL', headers: { 'x-api-key': key } });

  it('an answer bigger than the ceiling is refused (502), not buffered', async () => {
    const user = seedUser('big@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    upstreamProxyOverride = () => new Response('x'.repeat(6 * 1024 * 1024), { status: 200, headers: { 'content-type': 'application/json' } });
    const res = await lookup(key);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).detail).toMatch(/too large/);
    expect(res.body.length).toBeLessThan(2000);
  });

  it('a lookup that fails once is retried and the caller never sees the blip', async () => {
    const user = seedUser('blip@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    let n = 0;
    upstreamProxyOverride = () => (++n === 1 ? new Response('{}', { status: 503 }) : new Response('{"ok":true}', { status: 200 }));
    const res = await lookup(key);
    expect(res.statusCode).toBe(200);
    expect(n).toBe(2);
  });

  it('an analysis (which costs money) is never retried', async () => {
    const user = seedUser('nore@example.com');
    const key = JSON.parse((await createKey(user, ['market_validation_api'])).body).apiKey.key;
    let n = 0;
    upstreamProxyOverride = () => {
      n += 1;
      return new Response('{}', { status: 503 });
    };
    const res = await app.inject({ method: 'POST', url: '/gateway/market/research/analyze', headers: { 'x-api-key': key }, payload: { businessIdea: 'x' } });
    expect(res.statusCode).toBe(503);
    expect(n).toBe(1);
  });

  it('after repeated failures the gateway answers 503 with Retry-After without calling the backend at all', async () => {
    const user = seedUser('breaker@example.com');
    const key = JSON.parse((await createKey(user, ['registry_api'])).body).apiKey.key;
    upstreamProxyOverride = () => {
      throw new Error('ECONNREFUSED');
    };
    for (let i = 0; i < 5; i++) await lookup(key); // five failed calls in a row
    fetchCalls = [];
    const res = await lookup(key);
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(fetchCalls).toHaveLength(0);
    // ...and other backends are unaffected
    const mkey = JSON.parse((await createKey(user, ['market_validation_api'])).body).apiKey.key;
    upstreamProxyOverride = null;
    expect((await app.inject({ method: 'GET', url: '/gateway/market/scoring-methodology', headers: { 'x-api-key': mkey } })).statusCode).toBe(200);
  });

  it('one key cannot occupy more than two analyses at once (429); another key is unaffected', async () => {
    const user = seedUser('busy@example.com');
    const key = JSON.parse((await createKey(user, ['market_validation_api'])).body).apiKey.key;
    const other = JSON.parse((await createKey(user, ['market_validation_api'])).body).apiKey.key;
    const gates: Array<() => void> = [];
    upstreamProxyOverride = () => {
      throw new Error('replaced below');
    };
    const slow = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/research/analyze')) {
        await new Promise<void>((r) => gates.push(r));
        return new Response('{"score":1}', { status: 200 });
      }
      return fetchMock(input, init);
    });
    vi.stubGlobal('fetch', slow);
    try {
      const post = (k: string) => app.inject({ method: 'POST', url: '/gateway/market/research/analyze', headers: { 'x-api-key': k }, payload: { businessIdea: 'x' } });
      const p1 = post(key);
      const p2 = post(key);
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      const third = await post(key);
      expect(third.statusCode).toBe(429);
      expect(third.headers['retry-after']).toBe('1');
      const fromOther = post(other);
      await vi.waitFor(() => expect(gates).toHaveLength(3));
      gates.forEach((g) => g());
      expect((await p1).statusCode).toBe(200);
      expect((await p2).statusCode).toBe(200);
      expect((await fromOther).statusCode).toBe(200);
      // slots are free again
      const p4 = post(key);
      await vi.waitFor(() => expect(gates).toHaveLength(4));
      gates[3]();
      expect((await p4).statusCode).toBe(200);
    } finally {
      vi.stubGlobal('fetch', fetchMock);
      upstreamProxyOverride = null;
    }
  });
});
