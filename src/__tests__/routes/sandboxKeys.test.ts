// Sandbox keys: fixed sample answers, no backend called, no backend key minted, nothing capped.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
const realFetch = globalThis.fetch;
const savedConfig = { ...config };
const fetchMock = vi.fn(async () => new Response('{"unexpected":true}', { status: 500 }));

function seedUser(email: string) {
  const id = `sbx-${email}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, { id, email, password_hash: 'x', first_name: 'T', last_name: 'U', email_confirmed_at: now, created_at: now, updated_at: now });
  const token = `tok-${id}`;
  fakeDb.seedSession(token, { id: `s-${id}`, user_id: id, token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
  return { headers: { authorization: `Bearer ${token}` } };
}

beforeAll(async () => {
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
  config.registryApiUrl = 'http://registry.test';
  config.registryApiAdminKey = 'k';
  config.marketApiUrl = 'http://market.test';
  config.marketApiAdminKey = 'k';
  vi.stubGlobal('fetch', fetchMock);
  app = await buildApp();
});
afterAll(() => { Object.assign(config, savedConfig); vi.stubGlobal('fetch', realFetch); });
beforeEach(() => { fetchMock.mockClear(); fakeDb.gatewayKeys.clear(); fakeDb.gatewayGrants.length = 0; fakeDb.idempotencyKeys.clear(); });

async function sandboxKey(email: string, services = ['registry_api', 'market_validation_api']) {
  const user = seedUser(email);
  const res = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: user.headers, payload: { label: 'sbx', services, sandbox: true } });
  return { res, key: res.json().apiKey };
}
const call = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-api-key': key }, payload: payload as never });

describe('sandbox keys', () => {
  it('are created without asking any backend for a key, and look different from live keys', async () => {
    const { res, key } = await sandboxKey('a@example.com');
    expect(res.statusCode).toBe(201);
    expect(key.sandbox).toBe(true);
    expect(key.key.startsWith('deskgw_test_')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot carry the Desk API (it would show real data)', async () => {
    const { res } = await sandboxKey('b@example.com', ['desk_api']);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('api_key_sandbox_desk_api');
  });

  it('answer a name check with a fixed sample, and "taken" in the name is a conflict', async () => {
    const { key } = await sandboxKey('c@example.com');
    const ok = await call(key.key, 'POST', '/gateway/registry/name-availability', { businessName: 'Sunrise Bakery LLC', stateOfFormation: 'CO' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-desk-sandbox']).toBe('true');
    expect(ok.json()).toMatchObject({ status: 'likely_available', available: true, sandbox: true });
    const taken = await call(key.key, 'POST', '/gateway/registry/name-availability', { businessName: 'Taken Name LLC', stateOfFormation: 'CO' });
    expect(taken.json()).toMatchObject({ status: 'high_conflict', available: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answer a market analysis deterministically, and an idea containing "risky" scores low', async () => {
    const { key } = await sandboxKey('d@example.com');
    const a = (await call(key.key, 'POST', '/gateway/market/research/analyze', { businessIdea: 'Coffee shop', formationState: 'OH' })).json();
    const b = (await call(key.key, 'POST', '/gateway/market/research/analyze', { businessIdea: 'Coffee shop', formationState: 'OH' })).json();
    expect(a.overallScore).toBe(b.overallScore);
    expect(a.categories).toHaveLength(6);
    const risky = (await call(key.key, 'POST', '/gateway/market/research/analyze', { businessIdea: 'A risky idea', formationState: 'OH' })).json();
    expect(risky.overallScore).toBeLessThan(40);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('are not held to the daily analysis cap', async () => {
    const { key } = await sandboxKey('e@example.com');
    for (let i = 0; i < 12; i++) expect((await call(key.key, 'POST', '/gateway/market/research/analyze', { businessIdea: `idea ${i}` })).statusCode).toBe(200);
  });

  it('say so plainly when there is no sample for an endpoint', async () => {
    const { key } = await sandboxKey('f@example.com');
    const res = await call(key.key, 'POST', '/gateway/registry/name-trend', { businessName: 'X' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('sandbox_no_sample');
  });
});
