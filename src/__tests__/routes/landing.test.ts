import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { config } from '../../config';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});

describe('GET / (the public front door)', () => {
  it('serves an HTML page, with no sign-in needed', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<title>Desk API Library</title>');
  });

  it('lists every API in the library and how to use a key', async () => {
    const { body } = await app.inject({ method: 'GET', url: '/' });
    for (const name of ['Desk API', 'Registry API', 'Market Validation API']) expect(body).toContain(name);
    expect(body).toContain('x-api-key');
    expect(body).toContain('YOUR_API_KEY');
  });

  it('sends people to sign in and create a key in the web app', async () => {
    const { body } = await app.inject({ method: 'GET', url: '/' });
    expect(body).toContain(`href="${config.appBaseUrl.replace(/\/+$/, '')}/developer"`);
  });

  it('shows nothing secret or per-user', async () => {
    const { body } = await app.inject({ method: 'GET', url: '/' });
    for (const secret of [config.metricsDocsApiKey, config.gatewayKeyEncryptionSecret, config.registryApiAdminKey, config.marketApiAdminKey]) {
      if (secret) expect(body).not.toContain(secret);
    }
    expect(body).not.toMatch(/deskgw_[0-9a-f]{20}/);
  });

  it('only links the API reference when /docs is actually public', async () => {
    const saved = config.metricsDocsApiKey;
    try {
      config.metricsDocsApiKey = undefined;
      expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('href="/docs"');
      config.metricsDocsApiKey = 'some-key';
      expect((await app.inject({ method: 'GET', url: '/' })).body).not.toContain('href="/docs"');
    } finally {
      config.metricsDocsApiKey = saved;
    }
  });

  it('still sends the usual security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeTruthy();
  });
});
