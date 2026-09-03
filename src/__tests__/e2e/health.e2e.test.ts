import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

// These tests require a live Postgres instance with migrations applied.
// They are skipped automatically when E2E_DATABASE_URL is not set.
const hasDb = !!process.env.E2E_DATABASE_URL;

describe.skipIf(!hasDb)('E2E: health + DB connectivity', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('reports database ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.checks.database).toBe('ok');
  });

  it('GET /metrics returns prometheus-format metrics after a request', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-api-key': 'e2e-metrics-docs-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('desk_http_requests_total');
  });
});
