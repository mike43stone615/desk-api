// Compliance-OS / registry-api integration proxies — covers the
// fallback-catalog behavior when the upstream URL isn't configured (as in
// this test process — COMPLIANCE_OS_URL/REGISTRY_API_URL are unset). Both
// raw wildcard gateways (/compliance/*, /registry/*) were removed — see
// cross-20 and cross-44 in the audit — since neither had any real caller
// and both forwarded the caller's own headers/API key verbatim; the tests
// that used to check their fail-closed 503 now confirm they're gone (404).
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import { createFakeDb } from '../helpers/fake-db';
import { seedSignedIn } from '../helpers/signed-in';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let auth: Record<string, string>;
beforeAll(async () => {
  app = await buildApp();
  auth = seedSignedIn(pool as unknown as ReturnType<typeof createFakeDb>);
});

describe('compliance integration — falls back to the local catalog when COMPLIANCE_OS_URL is unset', () => {
  it('GET /integrations/compliance/business-types returns the fallback list', async () => {
    const res = await app.inject({ method: 'GET', headers: auth, url: '/integrations/compliance/business-types' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('GET /integrations/compliance/requirements/search returns the fallback search shape', async () => {
    const res = await app.inject({ method: 'GET', headers: auth, url: '/integrations/compliance/requirements/search?stateCode=CO' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe('registry integration — falls back to local name-availability heuristics when REGISTRY_API_URL is unset', () => {
  it('POST /functions/v1/check-business-name-availability returns a fallback result', async () => {
    const res = await app.inject({
      method: 'POST',
      headers: auth,
      url: '/functions/v1/check-business-name-availability',
      payload: { businessName: 'Acme Bank', stateOfFormation: 'CO' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBeDefined();
  });

  it('GET /functions/v1/business-structures returns the local structures catalog', async () => {
    const res = await app.inject({ method: 'GET', headers: auth, url: '/functions/v1/business-structures' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBeGreaterThan(0);
  });
});

describe('removed wildcard gateways stay gone', () => {
  it('GET /compliance/anything no longer exists (removed — see cross-20 in the audit)', async () => {
    const res = await app.inject({ method: 'GET', url: '/compliance/anything' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /registry/anything no longer exists (removed — see cross-44 in the audit)', async () => {
    const res = await app.inject({ method: 'GET', url: '/registry/anything' });
    expect(res.statusCode).toBe(404);
  });
});

describe('the setup-wizard helper routes are for signed-in people only', () => {
  const routes: Array<[string, string, object?]> = [
    ['GET', '/integrations/compliance/business-types'],
    ['GET', '/integrations/compliance/requirements/search?stateCode=CO'],
    ['GET', '/integrations/compliance/jurisdictions'],
    ['POST', '/integrations/market-research/analyze', { businessIdea: 'x' }],
    ['POST', '/functions/v1/check-business-name-availability', { name: 'Acme', state: 'CO' }],
    ['POST', '/functions/v1/check-dba-name-availability', { name: 'Acme' }],
    ['POST', '/functions/v1/check-trademark-availability', { name: 'Acme' }],
    ['POST', '/functions/v1/check-name-multi-state', { name: 'Acme' }],
    ['POST', '/functions/v1/check-names-batch', { names: ['Acme'] }],
    ['GET', '/functions/v1/registry-sync-status'],
    ['GET', '/functions/v1/business-structures'],
    ['GET', '/functions/v1/business-structures/llc'],
    ['POST', '/functions/v1/business-structures/recommend', {}],
    ['POST', '/functions/v1/analyze-business-setup', {}],
    ['POST', '/functions/v1/search-place-areas', { query: 'Denver' }],
  ];

  it('every one answers 401 with no session, on both the plain and /v1 URLs', async () => {
    for (const [method, url, payload] of routes) {
      for (const prefix of ['', '/v1']) {
        const res = await app.inject({ method: method as 'GET' | 'POST', url: prefix + url, payload });
        expect(res.statusCode, `${method} ${prefix}${url}`).toBe(401);
        expect(res.headers['content-type']).toMatch(/problem\+json/);
      }
    }
  });

  it('a bad or expired session is refused the same way', async () => {
    const res = await app.inject({ method: 'GET', url: '/functions/v1/business-structures', headers: { authorization: 'Bearer not-a-real-session' } });
    expect(res.statusCode).toBe(401);
  });

  it('an API Library key is not accepted here (keys use /v1/gateway/*)', async () => {
    const res = await app.inject({ method: 'GET', url: '/functions/v1/business-structures', headers: { 'x-api-key': 'deskgw_' + 'a'.repeat(48) } });
    expect(res.statusCode).toBe(401);
  });

  it('signed in, the same routes work', async () => {
    const res = await app.inject({ method: 'GET', url: '/functions/v1/business-structures', headers: auth });
    expect(res.statusCode).toBe(200);
  });
});
