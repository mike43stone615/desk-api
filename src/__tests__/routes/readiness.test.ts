// /health/ready: the database and Redis decide "ready"; the backends are reported but never fail it.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { resetDependencyCache } from '../../domain/health/dependencies';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
const realFetch = globalThis.fetch;
const saved = { ...config };
let app: FastifyInstance;
let health: Record<string, 'up' | 'down' | 'error' | 'hang'>;
let calls: string[];

beforeAll(async () => {
  config.registryApiUrl = 'http://registry.test';
  config.marketApiUrl = 'http://market.test';
  config.complianceOsUrl = 'http://compliance.test/';
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const which = url.includes('registry') ? 'registry' : url.includes('market') ? 'market' : 'compliance';
    const mode = health[which];
    if (mode === 'error') throw new Error('ECONNREFUSED');
    if (mode === 'hang') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response('{}', { status: mode === 'down' ? 503 : 200 });
  }));
  app = await buildApp();
});
afterAll(() => {
  Object.assign(config, saved);
  vi.stubGlobal('fetch', realFetch);
});
beforeEach(() => {
  health = { registry: 'up', market: 'up', compliance: 'up' };
  calls = [];
  resetDependencyCache();
});

const ready = async () => {
  const res = await app.inject({ method: 'GET', url: '/health/ready' });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

describe('GET /health/ready', () => {
  it('reports every backend as ok and is not degraded when all answer', async () => {
    const { status, body } = await ready();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, degraded: false, dependencies: { registry_api: 'ok', market_validation_api: 'ok', compliance_os: 'ok' } });
    expect(body.checks.database).toBe('ok');
    expect(calls.sort()).toEqual(['http://compliance.test/health', 'http://market.test/health', 'http://registry.test/health']);
  });

  it('a backend that is down makes the service degraded but still ready (200)', async () => {
    health.market = 'error';
    const { status, body } = await ready();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.dependencies).toMatchObject({ registry_api: 'ok', market_validation_api: 'down', compliance_os: 'ok' });
  });

  it('a backend that answers with an error status, or is too slow, counts as down', async () => {
    health.registry = 'down';
    health.compliance = 'hang';
    const { body } = await ready();
    expect(body.dependencies).toMatchObject({ registry_api: 'down', compliance_os: 'down', market_validation_api: 'ok' });
    expect(body.degraded).toBe(true);
  });

  it('a backend that is not configured is not_configured, and does not make it degraded', async () => {
    config.complianceOsUrl = undefined;
    try {
      const { body } = await ready();
      expect(body.dependencies.compliance_os).toBe('not_configured');
      expect(body.degraded).toBe(false);
      expect(calls.some((c) => c.includes('compliance'))).toBe(false);
    } finally {
      config.complianceOsUrl = 'http://compliance.test/';
    }
  });

  it('the database is what makes it not ready: 503 whatever the backends say', async () => {
    const original = fakeDb.query.getMockImplementation();
    fakeDb.query.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });
    const { status, body } = await ready();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.database).toBe('error');
    expect(body.dependencies.registry_api).toBe('ok');
    fakeDb.query.mockImplementation(original!);
  });

  it('answers from a short memory, so frequent polling does not become load on the backends', async () => {
    await ready();
    await ready();
    await ready();
    expect(calls).toHaveLength(3); // one round of three backends, not nine
    resetDependencyCache();
    await ready();
    expect(calls).toHaveLength(6);
  });

  it('is the same under /v1 and needs no sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).dependencies).toBeDefined();
  });

  it('the plain /health stays dependency-free and instant', async () => {
    health = { registry: 'error', market: 'error', compliance: 'error' };
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty('dependencies');
    expect(calls).toHaveLength(0);
  });

  it('publishes each backend as a metric an alert can watch', async () => {
    health.market = 'error';
    await ready();
    const { metricsRegistry } = await import('../../modules/metrics');
    const text = await metricsRegistry.metrics();
    expect(text).toMatch(/desk_dependency_up\{dependency="market_validation_api"\} 0/);
    expect(text).toMatch(/desk_dependency_up\{dependency="registry_api"\} 1/);
  });
});
