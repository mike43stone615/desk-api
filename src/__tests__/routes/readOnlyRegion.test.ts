// A read-only standby region answers reads and refuses changes; every answer says which region it came from.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { config } from '../../config';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
const saved = { region: config.region, readOnly: config.readOnly };
beforeAll(async () => { app = await buildApp(); }, 30_000);
afterAll(() => { Object.assign(config, saved); });

describe('regions', () => {
  it('every answer names its region, and /health says whether this copy is read-only', async () => {
    config.region = 'eu-west';
    config.readOnly = false;
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-region']).toBe('eu-west');
    expect(res.json()).toMatchObject({ region: 'eu-west', readOnly: false });
  });

  it('a read-only copy refuses every change with 503 region_read_only and Retry-After, but still answers reads and GraphQL', async () => {
    config.region = 'standby';
    config.readOnly = true;
    for (const [method, url] of [['POST', '/v1/auth/signin'], ['POST', '/v1/setup/drafts'], ['DELETE', '/v1/gateway/api-keys/x'], ['POST', '/v1/oauth/token']] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().code).toBe('region_read_only');
      expect(res.headers['retry-after']).toBe('30');
    }
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/status/incidents' })).statusCode).not.toBe(503);
    // GraphQL is a POST that only reads: it gets past the read-only gate (and is then refused for having no credentials)
    expect((await app.inject({ method: 'POST', url: '/v1/graphql', payload: { query: '{ viewer { id } }' } })).statusCode).toBe(401);
    config.readOnly = false;
  });
});
