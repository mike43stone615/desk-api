// Compliance-OS / registry-api integration proxies — covers the
// fallback-catalog behavior when the upstream URL isn't configured (as in
// this test process — COMPLIANCE_OS_URL/REGISTRY_API_URL are unset) and the
// api-gateway's fail-closed 503 for the same reason.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});

describe('compliance integration — falls back to the local catalog when COMPLIANCE_OS_URL is unset', () => {
  it('GET /integrations/compliance/business-types returns the fallback list', async () => {
    const res = await app.inject({ method: 'GET', url: '/integrations/compliance/business-types' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('GET /integrations/compliance/requirements/search returns the fallback search shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/integrations/compliance/requirements/search?stateCode=CO' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe('registry integration — falls back to local name-availability heuristics when REGISTRY_API_URL is unset', () => {
  it('POST /functions/v1/check-business-name-availability returns a fallback result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/functions/v1/check-business-name-availability',
      payload: { businessName: 'Acme Bank', stateOfFormation: 'CO' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBeDefined();
  });

  it('GET /functions/v1/business-structures returns the local structures catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/functions/v1/business-structures' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBeGreaterThan(0);
  });
});

describe('api gateway (/compliance/*, /registry/*) — fails closed when unconfigured', () => {
  it('GET /compliance/anything returns 503', async () => {
    const res = await app.inject({ method: 'GET', url: '/compliance/anything' });
    expect(res.statusCode).toBe(503);
  });

  it('GET /registry/anything returns 503', async () => {
    const res = await app.inject({ method: 'GET', url: '/registry/anything' });
    expect(res.statusCode).toBe(503);
  });
});
