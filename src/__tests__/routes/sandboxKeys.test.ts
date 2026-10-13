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
    for (let i = 0; i < 12; i++) expect((await call(key.key, 'POST', '/gateway/market/research/analyze', { businessIdea: `idea ${i}`, formationState: 'OH' })).statusCode).toBe(200);
  });

  it('have a sample for every endpoint a live key can call, under the public and the old spelling', async () => {
    const { key } = await sandboxKey('f@example.com');
    const calls: Array<['GET' | 'POST', string, unknown?]> = [
      ['POST', '/gateway/registry/name-availability', { businessName: 'X Co', stateOfFormation: 'FL' }],
      ['POST', '/gateway/registry/functions/v1/check-business-name-availability', { businessName: 'X Co', stateOfFormation: 'FL' }],
      ['POST', '/gateway/registry/dba-availability', { businessName: 'X Co', stateOfFormation: 'FL' }],
      ['POST', '/gateway/registry/trademark-availability', { businessName: 'X Co' }],
      ['POST', '/gateway/registry/multi-state-availability', { businessName: 'X Co', states: ['FL', 'VA'] }],
      ['POST', '/gateway/registry/batch-availability', { names: ['X Co', 'Y Co'], stateOfFormation: 'FL' }],
      ['POST', '/gateway/registry/name-trend', { businessName: 'X Co', stateOfFormation: 'FL' }],
      ['POST', '/gateway/registry/functions/v1/check-name-trend', { businessName: 'X Co' }],
      ['GET', '/gateway/registry/sync-status'],
      ['GET', '/gateway/registry/functions/v1/registry-sync-status'],
      ['GET', '/gateway/registry/business-structures'],
      ['GET', '/gateway/registry/business-structures/limited_liability_company'],
      ['POST', '/gateway/registry/business-structures/recommend', { ownerCount: 2 }],
      ['POST', '/gateway/market/research/analyze', { businessIdea: 'Coffee shop', formationState: 'FL' }],
      ['GET', '/gateway/market/scoring-methodology'],
    ];
    for (const [method, url, payload] of calls) {
      const res = await call(key.key, method, url, payload);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['x-desk-sandbox'], url).toBe('true');
      expect(res.json().sandbox, url).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Field lists copied from the live APIs (2026-10-13). A sandbox answer may add `sandbox`; nothing else may differ.
  it('answer with the same fields as the live APIs', async () => {
    const { key } = await sandboxKey('g@example.com');
    const fields = (o: object) => Object.keys(o).filter((k) => k !== 'sandbox').sort();
    const ENVELOPE = ['responseId', 'servedAt'];
    const NAME = ['status', 'available', 'message', 'matches', 'source', 'sourceUrl', 'verificationMode', 'lastCheckedAt', 'sourceUpdatedAt', 'disclaimer'];
    const name = (await call(key.key, 'POST', '/gateway/registry/name-availability', { businessName: 'Free Name', stateOfFormation: 'FL' })).json();
    expect(fields(name)).toEqual([...ENVELOPE, ...NAME].sort());
    expect(name.responseId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    const taken = (await call(key.key, 'POST', '/gateway/registry/name-availability', { businessName: 'Acme', stateOfFormation: 'FL' })).json();
    expect(fields(taken)).toEqual([...ENVELOPE, ...NAME, 'matchDetails', 'suggestions'].sort());
    expect(Object.keys(taken.matchDetails[0]).sort()).toEqual(['active', 'entityType', 'matchReason', 'matchType', 'name', 'score', 'status']);
    const tm = (await call(key.key, 'POST', '/gateway/registry/trademark-availability', { businessName: 'Acme' })).json();
    expect(fields(tm)).toEqual([...ENVELOPE, 'status', 'matches', 'source', 'sourceUrl', 'lastCheckedAt'].sort());
    expect(Object.keys(tm.matches[0]).sort()).toEqual(['goodsServices', 'intlClass', 'live', 'markLiteralElements', 'ownerName', 'registrationNumber', 'serialNumber']);
    const multi = (await call(key.key, 'POST', '/gateway/registry/multi-state-availability', { businessName: 'Free Name', states: ['FL', 'VA'] })).json();
    expect(fields(multi)).toEqual([...ENVELOPE, 'businessName', 'results'].sort());
    expect(Object.keys(multi.results)).toEqual(['FL', 'VA']);
    expect(fields(multi.results.FL)).toEqual(NAME.slice().sort());
    const batch = (await call(key.key, 'POST', '/gateway/registry/batch-availability', { names: ['A Co', 'Taken Co'], stateOfFormation: 'FL' })).json();
    expect(fields(batch)).toEqual([...ENVELOPE, 'stateOfFormation', 'results'].sort());
    expect(batch.results.map((r: { name: string }) => r.name)).toEqual(['A Co', 'Taken Co']);
    expect(batch.results[1].result.available).toBe(false);
    const trend = (await call(key.key, 'POST', '/gateway/registry/name-trend', { businessName: 'Sunrise', stateOfFormation: 'FL' })).json();
    expect(fields(trend)).toEqual([...ENVELOPE, 'businessName', 'recentFilingsCount', 'period', 'trend', 'topNames', 'commonCoWords', 'stateOfFormation'].sort());
    const sync = (await call(key.key, 'GET', '/gateway/registry/sync-status')).json();
    expect(fields(sync)).toEqual([...ENVELOPE, 'generatedAt', 'memoryCache', 'states', 'summary'].sort());
    const STRUCTURE = ['slug', 'name', 'category', 'family', 'aliases', 'summary', 'ownership', 'liability', 'taxation', 'management', 'formation', 'bestFor', 'cautions', 'taxElectionOptions', 'relatedStructures'];
    const list = (await call(key.key, 'GET', '/gateway/registry/business-structures')).json();
    expect(fields(list)).toEqual([...ENVELOPE, 'structures', 'count'].sort());
    expect(Object.keys(list.structures[0]).sort()).toEqual(STRUCTURE.slice().sort());
    const paged = (await call(key.key, 'GET', '/gateway/registry/business-structures?limit=1')).json();
    expect(paged).toMatchObject({ count: 1, total: 3, nextCursor: '1' });
    const rec = (await call(key.key, 'POST', '/gateway/registry/business-structures/recommend', { ownerCount: 2 })).json();
    expect(fields(rec)).toEqual([...ENVELOPE, 'recommendations', 'count'].sort());
    expect(Object.keys(rec.recommendations[0]).sort()).toEqual(['reasons', 'score', 'structure']);
    expect((await call(key.key, 'GET', '/gateway/registry/business-structures/no_such_thing')).statusCode).toBe(404);
    const analysis = (await call(key.key, 'POST', '/gateway/market/research/analyze', { businessIdea: 'Coffee shop', formationState: 'FL' })).json();
    expect(fields(analysis)).toEqual([...ENVELOPE, 'summary', 'confidence', 'categories', 'overallScore', 'riskFlags', 'recommendedNextActions', 'sourcesUsed', 'dataVintages', 'fallbackSources', 'paidSourcesExcluded', 'disclaimer'].sort());
    expect(['medium', 'limited']).toContain(analysis.confidence);
    expect(Object.keys(analysis.categories[0]).sort()).toEqual(['evidence', 'key', 'label', 'primarySource', 'rationale', 'reasons', 'score', 'subSignals']);
    const method = (await call(key.key, 'GET', '/gateway/market/scoring-methodology')).json();
    expect(fields(method)).toEqual([...ENVELOPE, 'overview', 'overallScore', 'redistribution', 'categories'].sort());
    expect(Object.keys(method.categories[0]).sort()).toEqual(['description', 'key', 'label', 'subSignals']);
  });

  it('refuse a call missing a required input, as a live key would', async () => {
    const { key } = await sandboxKey('h@example.com');
    for (const [url, payload] of [
      ['/gateway/registry/name-availability', { businessName: 'X' }],
      ['/gateway/registry/multi-state-availability', { businessName: 'X', states: [] }],
      ['/gateway/registry/batch-availability', { names: Array.from({ length: 11 }, (_, i) => `N${i}`), stateOfFormation: 'FL' }],
      ['/gateway/market/research/analyze', { businessIdea: 'Coffee shop' }],
    ] as const) {
      const res = await call(key.key, 'POST', url, payload);
      expect(res.statusCode, url).toBe(400);
      expect(res.headers['x-desk-sandbox'], url).toBe('true');
    }
  });
});
